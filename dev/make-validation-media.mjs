// Generates the synthetic media served by dev/validation-addon.mjs into .tmp/media/.
// Everything is produced locally with FFmpeg test sources (testsrc2 patterns and sine tones),
// so it carries no third-party content. Requires ffmpeg on the PATH.
// Run: node dev/make-validation-media.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../.tmp/media/", import.meta.url));
mkdirSync(out, { recursive: true });
const path = (name) => `${out}${name}`;
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });

writeFileSync(
  path("subs-en.srt"),
  "1\n00:00:01,000 --> 00:00:04,000\nEnglish subtitle one\n\n2\n00:00:05,000 --> 00:00:09,000\nEnglish subtitle <i>two</i>\n",
);
// Windows-1252 with CRLF line endings, as many older Spanish SRT files are.
writeFileSync(
  path("subs-es-1252.srt"),
  Buffer.from(
    "1\r\n00:00:01,000 --> 00:00:04,000\r\nSubtítulo español uno\r\n\r\n2\r\n00:00:05,000 --> 00:00:09,000\r\nCanción dos\r\n",
    "latin1",
  ),
);
writeFileSync(path("broken.srt"), "<html><body>404 Not Found</body></html>\n");
writeFileSync(
  path("styled.ass"),
  [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,48,&H0000FFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,0,2,10,10,40,1",
    "Style: Sign,Arial,36,&H00FF8000,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,40,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:06.00,Default,,0,0,0,,{\\c&H00FF00&}ASS styled line",
    "Dialogue: 0,0:00:02.00,0:00:08.00,Sign,,0,0,0,,{\\pos(640,100)}Top sign",
    "",
  ].join("\n"),
);

// 40 s, H.264 + two AAC tracks (English 440 Hz, Spanish 880 Hz), SRT eng/spa and ASS embedded.
ffmpeg(
  "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=40",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=40",
  "-f", "lavfi", "-i", "sine=frequency=880:duration=40",
  "-i", path("subs-en.srt"),
  "-sub_charenc", "CP1252", "-i", path("subs-es-1252.srt"),
  "-i", path("styled.ass"),
  "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3", "-map", "4", "-map", "5",
  "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
  "-c:s:0", "srt", "-c:s:1", "srt", "-c:s:2", "ass",
  "-metadata:s:a:0", "language=eng", "-metadata:s:a:0", "title=English",
  "-metadata:s:a:1", "language=spa", "-metadata:s:a:1", "title=Español",
  "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=spa",
  "-metadata:s:s:2", "language=eng", "-metadata:s:s:2", "title=Signs (ASS)",
  path("multitrack.mkv"),
);
ffmpeg("-i", path("multitrack.mkv"), "-map", "0:v", "-map", "0:a", "-c", "copy", "-movflags", "+faststart", path("multiaudio.mp4"));

// Three 25 s episodes with their number drawn on the picture.
const font = process.platform === "win32" ? "fontfile='C\\:/Windows/Fonts/arial.ttf':" : "";
for (const episode of [1, 2, 3]) {
  ffmpeg(
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=25",
    "-f", "lavfi", "-i", `sine=frequency=${300 * episode}:duration=25`,
    "-vf", `drawtext=${font}text='Episodio ${episode}':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:x=40:y=40`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
    path(`ep${episode}.mp4`),
  );
}

// HEVC copy of the H.264 fixture, for the conversion test.
ffmpeg("-i", fileURLToPath(new URL("../tests/fixtures/playback.mp4", import.meta.url)), "-c:v", "libx265", "-tag:v", "hvc1", "-c:a", "copy", path("hevc.mkv"));
console.log(`Media written to ${out}`);
