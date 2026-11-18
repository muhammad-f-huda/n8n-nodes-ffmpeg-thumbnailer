import { promises as fs } from 'fs';
import { extname } from 'path';

import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

import { runCommandWithStdin } from '../shared/ffmpeg';

type ResizeMode = 'fit' | 'fill' | 'stretch';
type OutputFormat = 'auto' | 'jpeg' | 'png' | 'webp';
type ConcreteFormat = Exclude<OutputFormat, 'auto'>;

// heic-decode has no bundled types.
const decodeHeic = require('heic-decode') as (options: {
	buffer: Buffer;
}) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;

const OUTPUTS: Record<ConcreteFormat, { mime: string; ext: string; codec: string }> = {
	jpeg: { mime: 'image/jpeg', ext: 'jpg', codec: 'mjpeg' },
	png: { mime: 'image/png', ext: 'png', codec: 'png' },
	webp: { mime: 'image/webp', ext: 'webp', codec: 'libwebp' },
};

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs']);
const MIME_BY_EXT: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.heic': 'image/heic',
	'.heif': 'image/heif',
};

function isHeic(buffer: Buffer): boolean {
	return (
		buffer.length > 12 &&
		buffer.toString('ascii', 4, 8) === 'ftyp' &&
		HEIC_BRANDS.has(buffer.toString('ascii', 8, 12))
	);
}

function toQscale(quality: number): number {
	return Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
}

function scaleFilter(width: number, height: number, mode: ResizeMode): string {
	const w = width > 0 ? width : -2;
	const h = height > 0 ? height : -2;
	if (width > 0 && height > 0) {
		if (mode === 'fit') return `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
		if (mode === 'fill') return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
	}
	return `scale=${w}:${h}`;
}

function concreteFormat(format: OutputFormat, sourceMime: string): ConcreteFormat {
	if (format !== 'auto') return format;
	if (sourceMime === 'image/png') return 'png';
	if (sourceMime === 'image/webp') return 'webp';
	return 'jpeg';
}

export class FfmpegImage implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'FFmpeg Image Resizer',
		name: 'ffmpegImage',
		icon: 'file:ffmpegImage.svg',
		group: ['transform'],
		version: 1,
		description: 'Resize an image (including HEIC) using FFmpeg',
		defaults: {
			name: 'FFmpeg Image Resizer',
		},
		inputs: ['main'],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Source',
				name: 'sourceType',
				type: 'options',
				options: [
					{
						name: 'Binary Data',
						value: 'binaryData',
						description: 'Image passed in from a previous node as binary data',
					},
					{
						name: 'File Path',
						value: 'filePath',
						description: 'Image file already on disk on the n8n host',
					},
				],
				default: 'binaryData',
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { sourceType: ['binaryData'] } },
				description: 'Name of the binary property that holds the image',
			},
			{
				displayName: 'File Path',
				name: 'filePath',
				type: 'string',
				default: '',
				required: true,
				placeholder: '/path/to/image.heic',
				displayOptions: { show: { sourceType: ['filePath'] } },
				description: 'Absolute path to the image file on the n8n host',
			},
			{
				displayName: 'Width',
				name: 'width',
				type: 'number',
				default: 0,
				description: 'Output width in pixels. 0 scales from the height.',
			},
			{
				displayName: 'Height',
				name: 'height',
				type: 'number',
				default: 0,
				description: 'Output height in pixels. 0 scales from the width.',
			},
			{
				displayName: 'Resize Mode',
				name: 'resizeMode',
				type: 'options',
				options: [
					{ name: 'Fit', value: 'fit' },
					{ name: 'Fill', value: 'fill' },
					{ name: 'Stretch', value: 'stretch' },
				],
				default: 'fit',
				description: 'How the image fits the requested size when both dimensions are set',
			},
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				options: [
					{ name: 'Auto', value: 'auto' },
					{ name: 'JPEG', value: 'jpeg' },
					{ name: 'PNG', value: 'png' },
					{ name: 'WebP', value: 'webp' },
				],
				default: 'auto',
			},
			{
				displayName: 'Quality',
				name: 'quality',
				type: 'number',
				default: 80,
				typeOptions: { minValue: 1, maxValue: 100 },
				displayOptions: { show: { outputFormat: ['auto', 'jpeg', 'webp'] } },
				description: 'JPEG / WebP quality from 1 to 100 (higher is better)',
			},
			{
				displayName: 'Output Binary Property',
				name: 'outputBinaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				description: 'Name of the binary property the resized image is written to',
			},
			{
				displayName: 'Output File Name',
				name: 'outputFileName',
				type: 'string',
				default: 'output',
				description: 'Base name of the generated image (without extension)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const sourceType = this.getNodeParameter('sourceType', i) as string;
				let input: Buffer;
				let sourceMime: string;
				let sourceLabel: string;

				if (sourceType === 'binaryData') {
					const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
					const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
					input = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
					sourceMime = binaryData.mimeType;
					sourceLabel = binaryData.fileName ?? 'binary input';
				} else {
					const filePath = this.getNodeParameter('filePath', i) as string;
					input = await fs.readFile(filePath);
					sourceMime = MIME_BY_EXT[extname(filePath).toLowerCase()] ?? '';
					sourceLabel = filePath;
				}

				let rawWidth = 0;
				let rawHeight = 0;
				// The bundled FFmpeg builds have no HEIC decoder, so decode to RGBA first.
				if (isHeic(input)) {
					const decoded = await decodeHeic({ buffer: input });
					rawWidth = decoded.width;
					rawHeight = decoded.height;
					input = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
					sourceMime = 'image/png'; // decoded RGBA cannot be written back as HEIC
				}

				const width = this.getNodeParameter('width', i, 0) as number;
				const height = this.getNodeParameter('height', i, 0) as number;
				const resizeMode = this.getNodeParameter('resizeMode', i, 'fit') as ResizeMode;
				const outputFormat = this.getNodeParameter('outputFormat', i, 'auto') as OutputFormat;
				const quality = this.getNodeParameter('quality', i, 80) as number;
				const outputBinaryPropertyName = this.getNodeParameter('outputBinaryPropertyName', i) as string;
				const outputFileName = this.getNodeParameter('outputFileName', i) as string;

				if (width <= 0 && height <= 0) {
					throw new NodeOperationError(this.getNode(), 'At least one dimension must be greater than zero.', {
						itemIndex: i,
					});
				}

				const format = concreteFormat(outputFormat, sourceMime);
				const args = ['-hide_banner', '-loglevel', 'error'];
				if (rawWidth > 0) {
					args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${rawWidth}x${rawHeight}`, '-i', 'pipe:0');
				} else {
					args.push('-f', 'image2pipe', '-i', 'pipe:0');
				}
				args.push('-vf', scaleFilter(width, height, resizeMode), '-frames:v', '1');
				if (format === 'jpeg') args.push('-q:v', String(toQscale(quality)));
				if (format === 'webp') args.push('-quality', String(quality));
				args.push('-f', 'image2pipe', '-vcodec', OUTPUTS[format].codec, 'pipe:1');

				const image = await runCommandWithStdin('ffmpeg', args, input);
				const { mime, ext } = OUTPUTS[format];
				const fileName = `${outputFileName}.${ext}`;
				const binary = await this.helpers.prepareBinaryData(image, fileName, mime);

				returnData.push({
					json: {
						fileName,
						fileSize: image.length,
						mimeType: mime,
						width,
						height,
						source: sourceLabel,
					},
					binary: { [outputBinaryPropertyName]: binary },
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw error instanceof NodeOperationError
					? error
					: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
