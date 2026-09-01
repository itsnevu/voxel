// Reel Fortune Anglers — mint page configuration.
// Paste the address printed by contracts/deploy.sh into chains[<id>].contract and set chainId.
// `?chain=84532` on the page URL overrides chainId for testing.
window.RF_MINT = {
  collection: { name: 'Reel Fortune Anglers', symbol: 'RFA', size: 1000 },
  // Set this to the chain you deployed on. Keep 31337 (local anvil) for testing
  // until the real contract address is pasted in below; then switch to 4663
  // (Robinhood Chain) or 46630 (Robinhood testnet).
  chainId: 4663,                        // LIVE on Robinhood Chain mainnet
  chains: {
    31337:    { name: 'Anvil (local)',  rpc: ['http://127.0.0.1:8545'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: '', contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3' },
    // Robinhood Chain — an Arbitrum Orbit L2, EVM-compatible, gas paid in ETH.
    // rpc[0] is publicnode (the official rpc.mainnet.chain.robinhood.com refuses
    // connections from some regions and the dRPC free tier blocks write methods);
    // the page only reads through it (mint tx goes via the wallet), so a
    // read-capable public endpoint is enough. dRPC is the read fallback.
    4663:     { name: 'Robinhood Chain',         rpc: ['https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://robinhoodchain.blockscout.com', contract: '0x24E754Ae2Ca4b7e150c307Fc87FF6504e02b9cac' },
    46630:    { name: 'Robinhood Chain Testnet', rpc: ['https://rpc.testnet.chain.robinhood.com'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://explorer.testnet.chain.robinhood.com', contract: '' },
    84532:    { name: 'Base Sepolia',   rpc: ['https://sepolia.base.org'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://sepolia.basescan.org', contract: '' },
    8453:     { name: 'Base',           rpc: ['https://mainnet.base.org'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://basescan.org', contract: '' },
    11155111: { name: 'Sepolia',        rpc: ['https://ethereum-sepolia-rpc.publicnode.com'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://sepolia.etherscan.io', contract: '' },
    137:      { name: 'Polygon',        rpc: ['https://polygon-rpc.com'], currency: { name: 'POL', symbol: 'POL', decimals: 18 }, explorer: 'https://polygonscan.com', contract: '' },
  },
  assets: { images: 'nft/images', json: 'nft/json', rarity: 'nft/rarity.json', collection: 'nft/collection.json' },
};
