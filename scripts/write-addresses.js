const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const START = '<!-- deployments:start -->';
const END = '<!-- deployments:end -->';

const NOT_DEPLOYED =
  'Not deployed yet. Run `npm run deploy` against a node that accepts state changing\n' +
  'calls, and this table fills itself in.';

const PENDING_V2 = '> **V2 is not deployed.** Run `npm run deploy:v2`.';

const PENDING_V3 =
  '> **V3 is not deployed.** `PauliV3Factory` has 24,498 bytes of init code even at\n' +
  '> `runs: 1`, because it embeds the pool\'s init code. The wallet RPC proxy\n' +
  '> (`qrlwallet.com/api/qrl-rpc/testnet`) caps a request body at ~51 KB, and an\n' +
  '> ML-DSA-87 signature plus public key already costs ~7.3 KB of that, leaving room\n' +
  '> for roughly 18 KB of init code. Nothing in the contracts or the build is\n' +
  '> blocking this.\n' +
  '>\n' +
  '> Waiting on an RPC endpoint without that body cap. Once one is available, point\n' +
  '> `QRL_RPC_URL` at it and run `npm run deploy:v3` — no code change needed.';

function tableFor(network, data) {
  const rows = [];
  const push = (label, value) => rows.push(`| ${label} | \`${value}\` |`);

  if (data.wqrl) push('WQRL (pre-existing)', data.wqrl);
  if (data.v2) {
    push('PauliV2Factory', data.v2.factory);
    push('PauliV2Router02', data.v2.router02);
  }
  if (data.v3) {
    push('PauliV3Factory', data.v3.factory);
    push('SwapRouter (V3)', data.v3.swapRouter);
    push('Quoter (V3)', data.v3.quoter);
    if (data.v3.positionManager) {
      push('NonfungiblePositionManager', data.v3.positionManager);
      push('PauliV3PositionDescriptor', data.v3.positionDescriptor);
      push('TickLens', data.v3.tickLens);
      push('V3Migrator', data.v3.migrator);
    }
  }

  const hashes = [];
  if (data.v2?.pairInitCodeHash) hashes.push(`- V2 pair init code hash: \`${data.v2.pairInitCodeHash}\``);
  if (data.v3?.poolInitCodeHash) hashes.push(`- V3 pool init code hash: \`${data.v3.poolInitCodeHash}\``);

  // Anything absent is called out rather than silently missing, so the table
  // never reads as "this is everything there is".
  const pending = [];
  if (!data.v2) pending.push(PENDING_V2);
  if (!data.v3) pending.push(PENDING_V3);

  return [
    `**${network}** (chainId 1337), addresses in \`Q\` form:`,
    '',
    '| Contract | Address |',
    '| --- | --- |',
    ...rows,
    ...(hashes.length ? ['', ...hashes] : []),
    ...(pending.length ? ['', ...pending] : []),
  ].join('\n');
}

function main() {
  const dir = path.join(ROOT, 'deployments');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];

  const body = files.length
    ? files
        .map((file) => tableFor(path.basename(file, '.json'), JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))))
        .join('\n\n')
    : NOT_DEPLOYED;

  const readme = fs.readFileSync(README, 'utf8');
  if (!readme.includes(START) || !readme.includes(END)) {
    console.error(`README.md is missing the ${START} / ${END} markers.`);
    process.exit(1);
  }

  const updated = readme.replace(
    new RegExp(`${START}[\\s\\S]*?${END}`),
    `${START}\n\n${body}\n\n${END}`
  );
  fs.writeFileSync(README, updated);
  console.log(files.length ? `README updated from ${files.join(', ')}` : 'README marked as not deployed');
}

main();
