// Smoke test: runs the compiled node end to end with a stubbed IExecuteFunctions.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FfmpegThumbnailer } = require('../dist/nodes/FfmpegThumbnailer/FfmpegThumbnailer.node.js');

// Stub heic-decode so the HEIC path can be tested without committing a large photo.
let heicDecodeCalls = 0;
const heicModulePath = require.resolve('heic-decode');
require.cache[heicModulePath] = {
	id: heicModulePath,
	filename: heicModulePath,
	loaded: true,
	exports: async () => {
		heicDecodeCalls++;
		const width = 16;
		const height = 12;
		return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
	},
};
const { FfmpegImage } = require('../dist/nodes/FfmpegImage/FfmpegImage.node.js');
delete require.cache[heicModulePath];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-test-'));
const video = path.join(tmp, 'clip.mp4');
// 6 second test video
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=15:duration=6', '-pix_fmt', 'yuv420p', video]);

const tempDirsBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('n8n-ffmpeg-thumbnailer-'));

function makeContext(params, inputData) {
	return {
		getInputData: () => inputData,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		continueOnFail: () => false,
		getNode: () => ({ name: 'FFmpeg Thumbnailer' }),
		helpers: {
			assertBinaryData: (i, prop) => inputData[i].binary[prop],
			getBinaryDataBuffer: async (i, prop) =>
				Buffer.from(inputData[i].binary[prop].data, 'base64'),
			prepareBinaryData: async (buffer, fileName, mimeType) => ({
				data: buffer.toString('base64'),
				fileName,
				mimeType,
			}),
		},
	};
}

async function run(params, inputData, i = 0) {
	const node = new FfmpegThumbnailer();
	return (await node.execute.call(makeContext(params, inputData)))[0];
}

async function runImage(params, inputData) {
	const node = new FfmpegImage();
	return (await node.execute.call(makeContext(params, inputData)))[0];
}

function pngSize(buffer) {
	assert.strictEqual(buffer.subarray(1, 4).toString(), 'PNG');
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function main() {
	const base = { outputBinaryPropertyName: 'thumbnail', outputFileName: 'thumb' };

	// 1. first frame, from binary data
	let out = await run(
		{
			...base,
			sourceType: 'binaryData',
			binaryPropertyName: 'data',
			timestampMode: 'firstFrame',
			outputFormat: 'jpeg',
			width: 320,
			height: 0,
			quality: 80,
		},
		[{ json: {}, binary: { data: { fileName: 'clip.mp4', mimeType: 'video/mp4', data: fs.readFileSync(video).toString('base64') } } }],
	);
	assert.strictEqual(out[0].json.fileName, 'thumb.jpg');
	assert.strictEqual(out[0].json.mimeType, 'image/jpeg');
	assert.strictEqual(out[0].json.timestamp, 0);
	assert.ok(out[0].binary.thumbnail.data.length > 0, 'jpeg produced');
	const jpeg = Buffer.from(out[0].binary.thumbnail.data, 'base64');
	assert.strictEqual(jpeg[0], 0xff);
	assert.strictEqual(jpeg[1], 0xd8); // JPEG SOI
	console.log('ok: first frame from binary, width scaled, jpeg output');

	// 2. percentage of duration, from file path, png output
	out = await run(
		{
			...base,
			sourceType: 'filePath',
			filePath: video,
			timestampMode: 'percentage',
			timestampValue: 50,
			outputFormat: 'png',
			width: 0,
			height: 0,
			quality: 80,
		},
		[{ json: {} }],
	);
	assert.strictEqual(out[0].json.fileName, 'thumb.png');
	assert.strictEqual(out[0].json.mimeType, 'image/png');
	assert.ok(Math.abs(out[0].json.timestamp - 3) < 0.5, `~3s expected, got ${out[0].json.timestamp}`);
	const png = Buffer.from(out[0].binary.thumbnail.data, 'base64');
	assert.deepStrictEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]); // PNG signature
	console.log('ok: percentage of duration via ffprobe, file path, png output');

	// 3. specific second
	out = await run(
		{ ...base, sourceType: 'filePath', filePath: video, timestampMode: 'specificSecond', timestampValue: 2.5, outputFormat: 'jpeg', width: 0, height: 240, quality: 90 },
		[{ json: {} }],
	);
	assert.strictEqual(out[0].json.timestamp, 2.5);
	console.log('ok: specific second, height scaled');

	// 4. invalid percentage throws
	await assert.rejects(
		run({ ...base, sourceType: 'filePath', filePath: video, timestampMode: 'percentage', timestampValue: 150, outputFormat: 'jpeg', width: 0, height: 0, quality: 80 }, [{ json: {} }]),
		/Persentase|Percentage/,
	);
	console.log('ok: invalid percentage throws');

	// 5. missing ffmpeg binary surfaces a clear error
	const node = new FfmpegThumbnailer();
	const originalPath = process.env.PATH;
	process.env.PATH = tmp;
	await assert.rejects(
		run({ ...base, sourceType: 'filePath', filePath: video, timestampMode: 'firstFrame', outputFormat: 'jpeg', width: 0, height: 0, quality: 80 }, [{ json: {} }]),
		/not found on PATH/,
	);
	process.env.PATH = originalPath;
	console.log('ok: missing ffmpeg reports a clear error');

	// 6. temp workspaces are cleaned up
	const leftover = fs
		.readdirSync(os.tmpdir())
		.filter((n) => n.startsWith('n8n-ffmpeg-thumbnailer-') && !tempDirsBefore.includes(n));
	assert.deepStrictEqual(leftover, [], `leftover temp dirs: ${leftover.join(', ')}`);
	console.log('ok: temp workspaces cleaned up');

	// 7. image resize: binary input, jpeg output
	const image = path.join(tmp, 'picture.jpg');
	execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=1:duration=1', '-frames:v', '1', image]);
	const imageBase = { outputBinaryPropertyName: 'resized', outputFileName: 'resized' };
	out = await runImage(
		{ ...imageBase, sourceType: 'binaryData', binaryPropertyName: 'data', width: 20, height: 0, resizeMode: 'fit', outputFormat: 'jpeg', quality: 80 },
		[{ json: {}, binary: { data: { fileName: 'picture.jpg', mimeType: 'image/jpeg', data: fs.readFileSync(image).toString('base64') } } }],
	);
	assert.strictEqual(out[0].json.fileName, 'resized.jpg');
	assert.strictEqual(out[0].json.mimeType, 'image/jpeg');
	const jpegOut = Buffer.from(out[0].binary.resized.data, 'base64');
	assert.deepStrictEqual([...jpegOut.subarray(0, 2)], [0xff, 0xd8]);
	console.log('ok: image resize from binary jpeg');

	// 8. image resize: file path input, png output, height drives width
	out = await runImage(
		{ ...imageBase, sourceType: 'filePath', filePath: image, width: 0, height: 10, resizeMode: 'fit', outputFormat: 'png' },
		[{ json: {} }],
	);
	assert.strictEqual(out[0].json.mimeType, 'image/png');
	const pngSizeOut = pngSize(Buffer.from(out[0].binary.resized.data, 'base64'));
	assert.strictEqual(pngSizeOut.height, 10);
	assert.ok(pngSizeOut.width > 0);
	console.log('ok: image resize from file path to png');

	// 9. HEIC input is decoded to raw pixels before resizing; Auto -> PNG
	out = await runImage(
		{ ...imageBase, sourceType: 'binaryData', binaryPropertyName: 'data', width: 8, height: 0, resizeMode: 'fit', outputFormat: 'auto' },
		[{ json: {}, binary: { data: { fileName: 'photo.heic', mimeType: 'image/heic', data: Buffer.from('0000ftypheic0000', 'ascii').toString('base64') } } }],
	);
	assert.strictEqual(heicDecodeCalls, 1, 'heic-decode was used');
	assert.strictEqual(out[0].json.mimeType, 'image/png');
	assert.deepStrictEqual(pngSize(Buffer.from(out[0].binary.resized.data, 'base64')), { width: 8, height: 6 });
	console.log('ok: HEIC decoded then resized');

	// 10. at least one dimension is required
	await assert.rejects(
		runImage(
			{ ...imageBase, sourceType: 'filePath', filePath: image, width: 0, height: 0, resizeMode: 'fit', outputFormat: 'png' },
			[{ json: {} }],
		),
		/At least one dimension/,
	);
	console.log('ok: image resize rejects zero dimensions');

	// 11. thumbnail resize mode changes the output geometry
	out = await run(
		{ ...base, sourceType: 'filePath', filePath: video, timestampMode: 'firstFrame', outputFormat: 'png', width: 320, height: 100, resizeMode: 'fit', quality: 80 },
		[{ json: {} }],
	);
	const fitSize = pngSize(Buffer.from(out[0].binary.thumbnail.data, 'base64'));
	assert.strictEqual(fitSize.height, 100);
	assert.ok(fitSize.width < 320, `fit width should preserve aspect, got ${fitSize.width}`);

	out = await run(
		{ ...base, sourceType: 'filePath', filePath: video, timestampMode: 'firstFrame', outputFormat: 'png', width: 320, height: 100, resizeMode: 'stretch', quality: 80 },
		[{ json: {} }],
	);
	assert.deepStrictEqual(pngSize(Buffer.from(out[0].binary.thumbnail.data, 'base64')), { width: 320, height: 100 });
	console.log('ok: thumbnail resize mode fit vs stretch');

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log('\nall smoke tests passed');}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
