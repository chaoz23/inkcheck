const fs = require("node:fs");
const path = require("node:path");

if (process.env.INKCHECK_TEST_FORBID_CHECKPOINT_DECODE === "1") {
  const zlib = require("node:zlib");
  const marker = process.env.INKCHECK_TEST_CHECKPOINT_DECODE_MARKER;
  zlib.gunzipSync = () => {
    if (marker) fs.writeFileSync(marker, "checkpoint payload decode attempted\n");
    const error = new RangeError("checkpoint recovery must not decode the published payload");
    error.code = "ERR_BUFFER_TOO_LARGE";
    throw error;
  };
}

const { compile, scanKnots } = require("../../dist/inklecate");
const { exploreSharedResumable } = require("../../dist/explore");
const { saveCheckpointArtifact } = require("../../dist/checkpoints");

async function main() {
  const projectRoot = path.resolve(process.argv[2]);
  const story = path.join(projectRoot, "story.ink");
  const maxStates = Number(process.argv[3] ?? 20);
  const compiled = await compile(story);
  const options = {
    maxStates,
    preserveTurnState: false,
    preserveRandomState: false,
  };
  if (process.env.INKCHECK_TEST_CHECKPOINT_MAX_DEPTH) {
    options.maxDepth = Number(process.env.INKCHECK_TEST_CHECKPOINT_MAX_DEPTH);
  }
  if (process.env.INKCHECK_TEST_CHECKPOINT_SEED) {
    options.seed = Number(process.env.INKCHECK_TEST_CHECKPOINT_SEED);
  }
  const checkpoint = exploreSharedResumable(compiled.storyJson, scanKnots(story), [], options).checkpoint;
  const reference = await saveCheckpointArtifact(projectRoot, story, checkpoint);
  process.stdout.write(`${JSON.stringify(reference)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exitCode = 1;
});
