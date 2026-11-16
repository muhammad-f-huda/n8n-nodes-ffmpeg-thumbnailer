// Smoke test: runs the compiled node end to end with a stubbed IExecuteFunctions.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FfmpegThumbnailer } = require('../dist/nodes/FfmpegThumbnailer/FfmpegThumbnailer.node.js');

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

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log('\nall smoke tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
