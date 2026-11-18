import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { extname, join } from 'path';

import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

import { runCommand } from '../shared/ffmpeg';

type TimestampMode = 'firstFrame' | 'specificSecond' | 'percentage';
type OutputFormat = 'jpeg' | 'png';

const MIME_TYPES: Record<OutputFormat, string> = {
	jpeg: 'image/jpeg',
	png: 'image/png',
};

const VIDEO_MIME_EXT: Record<string, string> = {
	'video/mp4': '.mp4',
	'video/quicktime': '.mov',
	'video/x-matroska': '.mkv',
	'video/webm': '.webm',
	'video/x-msvideo': '.avi',
	'video/mpeg': '.mpg',
};

async function probeDuration(inputPath: string): Promise<number> {
	const output = await runCommand('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format=duration',
		'-of',
		'default=noprint_wrappers=1:nokey=1',
		inputPath,
	]);
	const duration = Number.parseFloat(output.toString().trim());
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error('Could not determine the video duration with ffprobe.');
	}
	return duration;
}

async function resolveTimestamp(
	mode: TimestampMode,
	value: number,
	inputPath: string,
): Promise<number> {
	if (mode === 'firstFrame') return 0;
	if (mode === 'specificSecond') return value;
	const duration = await probeDuration(inputPath);
	return (value / 100) * duration;
}

/** Maps a 1-100 quality (higher is better) to ffmpeg's qscale (31-2, lower is better). */
function toQscale(quality: number): number {
	return Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
}

function buildArgs(
	inputPath: string,
	timestamp: number,
	format: OutputFormat,
	width: number,
	height: number,
	quality: number,
): string[] {
	const args = ['-hide_banner', '-loglevel', 'error'];
	
	// Seeking before -i is fast and, since ffmpeg 2.1, frame accurate.
	if (timestamp > 0) args.push('-ss', String(timestamp));
	args.push('-i', inputPath, '-frames:v', '1', '-an');
	
	if (width > 0 || height > 0) {
		args.push('-vf', `scale=${width > 0 ? width : -2}:${height > 0 ? height : -2}`);
	}
	
	if (format === 'jpeg') {
		args.push('-q:v', String(toQscale(quality)));
	}
	
	// Writing to stdout avoids a second temp file on disk.
	args.push('-f', 'image2pipe', '-vcodec', format === 'jpeg' ? 'mjpeg' : 'png', 'pipe:1');
	
	return args;
}

export class FfmpegThumbnailer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'FFmpeg Thumbnailer',
		name: 'ffmpegThumbnailer',
		icon: 'file:ffmpegThumbnailer.svg',
		group: ['transform'],
		version: 1,
		description: 'Generate a thumbnail image from a video using FFmpeg',
		defaults: {
			name: 'FFmpeg Thumbnailer',
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
						description: 'Video passed in from a previous node as binary data',
					},
					{
						name: 'File Path',
						value: 'filePath',
						description: 'Video already on disk on the n8n host',
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
				description: 'Name of the binary property that holds the video',
			},
			{
				displayName: 'File Path',
				name: 'filePath',
				type: 'string',
				default: '',
				required: true,
				placeholder: '/path/to/video.mp4',
				displayOptions: { show: { sourceType: ['filePath'] } },
				description: 'Absolute path to the video file on the n8n host',
			},
			{
				displayName: 'Timestamp',
				name: 'timestampMode',
				type: 'options',
				options: [
					{ name: 'First Frame', value: 'firstFrame' },
					{ name: 'Specific Second', value: 'specificSecond' },
					{ name: 'Percentage of Duration', value: 'percentage' },
				],
				default: 'firstFrame',
			},
			{
				displayName: 'Timestamp Value',
				name: 'timestampValue',
				type: 'number',
				default: 0,
				displayOptions: { show: { timestampMode: ['specificSecond', 'percentage'] } },
				description: 'Seconds into the video, or a percentage (0-100) of its duration',
			},
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				options: [
					{ name: 'JPEG', value: 'jpeg' },
					{ name: 'PNG', value: 'png' },
				],
				default: 'jpeg',
			},
			{
				displayName: 'Width',
				name: 'width',
				type: 'number',
				default: 0,
				description: 'Thumbnail width in pixels. 0 keeps the source width (scales by height).',
			},
			{
				displayName: 'Height',
				name: 'height',
				type: 'number',
				default: 0,
				description: 'Thumbnail height in pixels. 0 keeps the source height (scales by width).',
			},
			{
				displayName: 'Quality',
				name: 'quality',
				type: 'number',
				default: 80,
				typeOptions: { minValue: 1, maxValue: 100 },
				displayOptions: { show: { outputFormat: ['jpeg'] } },
				description: 'JPEG quality from 1 to 100 (higher is better)',
			},
			{
				displayName: 'Output Binary Property',
				name: 'outputBinaryPropertyName',
				type: 'string',
				default: 'thumbnail',
				required: true,
				description: 'Name of the binary property the thumbnail is written to',
			},
			{
				displayName: 'Output File Name',
				name: 'outputFileName',
				type: 'string',
				default: 'thumbnail',
				description: 'Base name of the generated thumbnail (without extension)',
			},
		],
	};
	
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		
		for (let i = 0; i < items.length; i++) {
			let tempDir: string | null = null;
			
			try {
				const sourceType = this.getNodeParameter('sourceType', i) as string;
				let inputPath: string;
				let sourceLabel: string;
				
				if (sourceType === 'binaryData') {
					const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
					const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
					const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
					
					tempDir = await fs.mkdtemp(join(tmpdir(), 'n8n-ffmpeg-thumbnailer-'));
					const extension = binaryData.fileName
						? extname(binaryData.fileName)
						: VIDEO_MIME_EXT[binaryData.mimeType] ?? '';
					inputPath = join(tempDir, `input${extension}`);
					await fs.writeFile(inputPath, buffer);
					sourceLabel = binaryData.fileName ?? 'binary input';
				} else {
					inputPath = this.getNodeParameter('filePath', i) as string;
					sourceLabel = inputPath;
				}
				
				const timestampMode = this.getNodeParameter('timestampMode', i) as TimestampMode;
				const timestampValue = this.getNodeParameter('timestampValue', i, 0) as number;
				const outputFormat = this.getNodeParameter('outputFormat', i) as OutputFormat;
				const width = this.getNodeParameter('width', i, 0) as number;
				const height = this.getNodeParameter('height', i, 0) as number;
				const quality = this.getNodeParameter('quality', i, 80) as number;
				const outputBinaryPropertyName = this.getNodeParameter(
					'outputBinaryPropertyName',
					i,
				) as string;
				const outputFileName = this.getNodeParameter('outputFileName', i) as string;
				
				if (timestampMode === 'specificSecond' && timestampValue < 0) {
					throw new NodeOperationError(this.getNode(), 'Timestamp must be zero or greater.', {
						itemIndex: i,
					});
				}
				if (timestampMode === 'percentage' && (timestampValue < 0 || timestampValue > 100)) {
					throw new NodeOperationError(this.getNode(), 'Percentage must be between 0 and 100.', {
						itemIndex: i,
					});
				}
				
				const timestamp = await resolveTimestamp(timestampMode, timestampValue, inputPath);
				const mimeType = MIME_TYPES[outputFormat];
				const extension = outputFormat === 'jpeg' ? 'jpg' : 'png';
				const fileName = `${outputFileName}.${extension}`;
				
				const thumbnail = await runCommand(
					'ffmpeg',
					buildArgs(inputPath, timestamp, outputFormat, width, height, quality),
				);
				
				const binary = await this.helpers.prepareBinaryData(thumbnail, fileName, mimeType);
				
				returnData.push({
					json: {
						fileName,
						fileSize: thumbnail.length,
						mimeType,
						timestamp,
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
			} finally {
				// Clear the temp workspace on success and on failure so nothing is left behind.
				if (tempDir) {
					await fs.rm(tempDir, { recursive: true, force: true });
				}
			}
		}
		
		return [returnData];
	}
}
