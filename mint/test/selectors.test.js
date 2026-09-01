#!/usr/bin/env node
/* Re-derives every hard-coded selector in mint/eth.js with `cast sig`, checks the ABI encoders
   against `cast calldata` / `cast abi-encode`, and — when contracts/ReelFortuneAnglers.abi.json
   exists — checks that every function/error the page uses is really in the compiled ABI.
   Run: node mint/test/selectors.test.js */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RFEth = require(path.join(ROOT, 'mint', 'eth.js'));

let failures = 0, checks = 0;
function ok(cond, label, extra) {
  checks++;
  if (cond) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label + (extra ? '\n       ' + extra : ''));
}

function findCast() {
  const candidates = ['cast', path.join(os.homedir(), '.foundry', 'bin', 'cast')];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe' }); return c; } catch (e) { /* next */ }
  }
  return null;
}
const CAST = findCast();
if (!CAST) {
  console.error('cast (Foundry) not found on PATH or in ~/.foundry/bin — cannot re-derive selectors.\n' +
    'Install: curl -L https://foundry.paradigm.xyz | bash && foundryup');
  process.exit(2);
}
const cast = (...args) => execFileSync(CAST, args, { stdio: 'pipe' }).toString().trim();

console.log('selectors (cast sig)');
for (const [sig, sel] of Object.entries(RFEth.SELECTORS)) {
  const got = cast('sig', sig);
  ok(got === sel, `${sig} → ${sel}`, `cast sig says ${got}`);
}
console.log('error selectors (cast sig)');
for (const [sig, sel] of Object.entries(RFEth.ERRORS)) {
  const got = cast('sig', sig);
  ok(got === sel, `${sig} → ${sel}`, `cast sig says ${got}`);
}

console.log('calldata encoding (cast calldata)');
{
  const want = cast('calldata', 'mint(uint256)', '3');
  ok(RFEth.encodeCall('mint(uint256)', [3]) === want, 'mint(uint256) 3', want);
  const addr = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const want2 = cast('calldata', 'tokensOfOwner(address)', addr);
  ok(RFEth.encodeCall('tokensOfOwner(address)', [addr]) === want2, 'tokensOfOwner(address)', want2);
  const big = (1n << 255n) + 12345n;
  const want3 = cast('calldata', 'mint(uint256)', big.toString());
  ok(RFEth.encodeCall('mint(uint256)', [big]) === want3, 'mint(uint256) 2^255+12345', want3);
}

console.log('return-data decoding (cast abi-encode)');
{
  const arr = cast('abi-encode', 'f(uint256[])', '[1,2,1000]');
  const dec = RFEth.decodeUintArray(arr);
  ok(dec.length === 3 && dec[0] === 1n && dec[1] === 2n && dec[2] === 1000n, 'uint256[] [1,2,1000]', dec.join(','));
  const empty = cast('abi-encode', 'f(uint256[])', '[]');
  ok(RFEth.decodeUintArray(empty).length === 0, 'uint256[] []');
  const s = 'https://reelfortune.example/nft/json/7.json';
  const str = cast('abi-encode', 'f(string)', s);
  ok(RFEth.decodeString(str) === s, 'string ' + s, RFEth.decodeString(str));
  const long = 'Reel Fortune Anglers — 1000 voxel anglers, one per island ☀️🎣 (long enough to span three words)';
  const longEnc = cast('abi-encode', 'f(string)', long);
  ok(RFEth.decodeString(longEnc) === long, 'string (multi-word, utf-8)');
  ok(RFEth.decodeString(cast('abi-encode', 'f(string)', '')) === '', 'string ""');
  ok(RFEth.decodeBool(cast('abi-encode', 'f(bool)', 'true')) === true, 'bool true');
  ok(RFEth.decodeBool(cast('abi-encode', 'f(bool)', 'false')) === false, 'bool false');
  const u = cast('abi-encode', 'f(uint256)', '5000000000000000');
  ok(RFEth.decodeUint(u) === 5000000000000000n, 'uint256 5e15');
  ok(RFEth.formatEther(5000000000000000n) === '0.005', 'formatEther(5e15) = 0.005', RFEth.formatEther(5000000000000000n));
  ok(RFEth.formatEther(1n * 10n ** 18n) === '1', 'formatEther(1e18) = 1');
  ok(RFEth.formatEther(123456789n * 10n ** 9n, 4) === '0.1234', 'formatEther rounds down to 4 dp');
  ok(RFEth.toHex(0n) === '0x0' && RFEth.toHex(255n) === '0xff', 'toHex');
}

console.log('revert decoding');
{
  const r = RFEth.decodeRevert(RFEth.ERRORS['WalletLimit()']);
  ok(r && r.name === 'WalletLimit()', 'WalletLimit() → name');
  const errStr = RFEth.ERRORS['Error(string)'] + cast('abi-encode', 'f(string)', 'nope').slice(2);
  const r2 = RFEth.decodeRevert(errStr);
  ok(r2 && r2.message === 'nope', 'Error(string) "nope"', JSON.stringify(r2));
  const nested = { code: -32603, data: { originalError: { data: RFEth.ERRORS['SoldOut()'] } } };
  ok(RFEth.explainError(nested) === RFEth.ERROR_TEXT['SoldOut()'], 'explainError digs nested revert data');
  ok(/cancelled/.test(RFEth.explainError({ code: 4001, message: 'User rejected the request.' })), 'explainError 4001');
}

console.log('Transfer log parsing');
{
  const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const logs = [
    { address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', topics: [RFEth.TRANSFER_TOPIC, '0x' + '0'.repeat(64), '0x' + RFEth.encodeAddress(to), '0x' + RFEth.encodeUint(7)] },
    { address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', topics: [RFEth.TRANSFER_TOPIC, '0x' + '0'.repeat(64), '0x' + RFEth.encodeAddress('0x' + 'ab'.repeat(20)), '0x' + RFEth.encodeUint(8)] },
    { address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', topics: ['0x' + 'ee'.repeat(32), '0x' + '0'.repeat(64), '0x' + RFEth.encodeAddress(to), '0x' + RFEth.encodeUint(9)] },
  ];
  const mine = RFEth.parseReceiptTransfers(logs, to);
  ok(mine.length === 1 && mine[0].tokenId === 7n, 'filters by `to` and topic0', JSON.stringify(mine.map(m => String(m.tokenId))));
  ok(RFEth.parseReceiptTransfers(logs).length === 2, 'unfiltered returns every Transfer');
}

const abiPath = path.join(ROOT, 'contracts', 'ReelFortuneAnglers.abi.json');
if (fs.existsSync(abiPath)) {
  console.log('ABI cross-check (' + path.relative(ROOT, abiPath) + ')');
  let abi;
  try { abi = JSON.parse(fs.readFileSync(abiPath, 'utf8')); } catch (e) { abi = null; ok(false, 'abi json parses', e.message); }
  if (abi) {
    if (!Array.isArray(abi) && abi && Array.isArray(abi.abi)) abi = abi.abi;
    const typeOf = (i) => i.type === 'tuple' ? '(' + i.components.map(typeOf).join(',') + ')' : i.type;
    const sigs = new Set(abi.filter(x => x.type === 'function' || x.type === 'error').map(x => `${x.type}:${x.name}(${(x.inputs || []).map(typeOf).join(',')})`));
    for (const sig of Object.keys(RFEth.SELECTORS)) ok(sigs.has('function:' + sig), 'function ' + sig + ' in ABI');
    for (const sig of Object.keys(RFEth.ERRORS)) {
      if (sig === 'Error(string)' || sig === 'Panic(uint256)') continue; // Solidity built-ins, never in an ABI
      ok(sigs.has('error:' + sig), 'error ' + sig + ' in ABI');
    }
    const ev = abi.find(x => x.type === 'event' && x.name === 'Transfer');
    ok(!!ev && ev.inputs.length === 3 && ev.inputs.every(i => i.indexed), 'Transfer event has 3 indexed inputs (tokenId in topics[3])');
  }
} else {
  console.log('ABI cross-check skipped: contracts/ReelFortuneAnglers.abi.json not present yet');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
