#!/usr/bin/env node
/**
 * A stand-in for mpv, for the probe's own test. It creates the IPC target it was asked for and speaks just
 * enough of the protocol to reproduce the race that broke `gate`: an EVENT arrives before the reply.
 *
 *   node tests/scripts/fake-mpv-events.mjs --input-ipc-server=<target>
 */
import net from "node:net";

const target = process.argv
	.find((argument) => argument.startsWith("--input-ipc-server="))
	?.slice("--input-ipc-server=".length);
if (!target) {
	process.stderr.write("fake-mpv: missing --input-ipc-server\n");
	process.exit(1);
}

const server = net.createServer((socket) => {
	socket.setEncoding("utf8");
	let buffer = "";

	socket.on("data", (chunk) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (line.trim() === "") continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const requestId = message.request_id;

			if (requestId !== undefined && Array.isArray(message.command) && message.command[0] === "quit") {
				socket.end();
				server.close();
				process.exit(0);
			}

			// The whole point: an event first, sharing the stream with the reply.
			socket.write(`${JSON.stringify({ event: "idle" })}\n`);
			socket.write(`${JSON.stringify({ error: "success", data: "mpv fake", request_id: requestId })}\n`);
		}
	});
});

server.listen(target);
