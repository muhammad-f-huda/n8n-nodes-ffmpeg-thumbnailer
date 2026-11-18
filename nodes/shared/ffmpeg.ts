import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

function commandError(command: string, error: NodeJS.ErrnoException): Error {
	return error.code === 'ENOENT'
		? new Error(
				`${command} was not found on PATH. Install FFmpeg (which includes ${command}) and make sure it is accessible to the n8n process.`,
			)
		: error;
}

function collect(command: string, child: ChildProcessWithoutNullStreams): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		child.on('error', (error: NodeJS.ErrnoException) => reject(commandError(command, error)));
		child.on('close', (code, signal) => {
			if (code === 0) {
				resolve(Buffer.concat(stdout));
				return;
			}
			const message = Buffer.concat(stderr).toString().trim();
			const status = code === null ? `was killed by signal ${signal}` : `exited with code ${code}`;
			reject(new Error(`${command} ${status}${message ? `: ${message}` : ''}`));
		});
	});
}

export function runCommand(command: string, args: string[]): Promise<Buffer> {
	return collect(command, spawn(command, args));
}

export function runCommandWithStdin(command: string, args: string[], input: Buffer): Promise<Buffer> {
	const child = spawn(command, args);
	const output = collect(command, child);

	// ffmpeg may close stdin early (invalid input); its exit code reports the cause.
	child.stdin.on('error', () => {});
	child.stdin.end(input);

	return output;
}
