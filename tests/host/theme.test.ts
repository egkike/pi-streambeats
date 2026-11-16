/**
 * Theme mapping (S3, S8). The core names roles; the adapter is the only place that knows which
 * host token a role means. A fake theme proves the translation without a terminal, and the
 * opening-sequence accessors are used because the renderer composes role prefixes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type HostTheme, toViewTheme } from "../../lib/host/theme.ts";

const host: HostTheme = {
	fg: (token, text) => `<fg:${token}>${text}`,
	bg: (token, text) => `<bg:${token}>${text}`,
	getFgAnsi: (token) => `<open-fg:${token}>`,
	getBgAnsi: (token) => `<open-bg:${token}>`,
	bold: (text) => `<b>${text}</b>`,
};

describe("theme mapping (S3)", () => {
	it("maps every foreground role to the host's foreground token", () => {
		const theme = toViewTheme(host);

		assert.deepEqual(
			[
				theme.fg("text"),
				theme.fg("dim"),
				theme.fg("muted"),
				theme.fg("accent"),
				theme.fg("success"),
				theme.fg("warning"),
				theme.fg("error"),
				theme.fg("border"),
			],
			[
				"<open-fg:text>",
				"<open-fg:dim>",
				"<open-fg:muted>",
				"<open-fg:accent>",
				"<open-fg:success>",
				"<open-fg:warning>",
				"<open-fg:error>",
				"<open-fg:border>",
			],
		);
	});

	it("maps the surface role to the host's selected background", () => {
		const theme = toViewTheme(host);

		assert.equal(theme.bg("surface"), "<open-bg:selectedBg>");
	});

	it("keeps bold as text styling and dim as the host's dim token", () => {
		const theme = toViewTheme(host);

		assert.equal(theme.bold("sb-music"), "<b>sb-music</b>");
		assert.equal(theme.dim("esc"), "<fg:dim>esc");
	});
});
