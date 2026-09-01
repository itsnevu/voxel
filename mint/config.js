// Reel Fortune Anglers — mint page configuration.
// Paste the address printed by contracts/deploy.sh into chains[<id>].contract and set chainId.
// `?chain=84532` on the page URL overrides chainId for testing.
window.RF_MINT = {
  collection: { name: 'Reel Fortune Anglers', symbol: 'RFA', size: 1000 },
  // Set this to the chain you deployed on. Keep 31337 (local anvil) for testing
  // until the real contract address is pasted in below; then switch to 4663
  // (Robinhood Chain) or 46630 (Robinhood testnet).
  chainId: 31337,                       // the chain the page mints on; must be a key of chains
  chains: {
    31337:    { name: 'Anvil (local)',  rpc: ['http://127.0.0.1:8545'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: '', contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3' },
    // Robinhood Chain — an Arbitrum Orbit L2, EVM-compatible, gas paid in ETH.
    // Paste the deployed address into `contract` after running deploy.sh, then
    // set chainId above to 4663 (mainnet) or 46630 (testnet).
    4663:     { name: 'Robinhood Chain',         rpc: ['https://rpc.mainnet.chain.robinhood.com'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://robinhoodchain.blockscout.com', contract: '' },
    46630:    { name: 'Robinhood Chain Testnet', rpc: ['https://rpc.testnet.chain.robinhood.com'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://explorer.testnet.chain.robinhood.com', contract: '' },
    84532:    { name: 'Base Sepolia',   rpc: ['https://sepolia.base.org'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://sepolia.basescan.org', contract: '' },
    8453:     { name: 'Base',           rpc: ['https://mainnet.base.org'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://basescan.org', contract: '' },
    11155111: { name: 'Sepolia',        rpc: ['https://ethereum-sepolia-rpc.publicnode.com'], currency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, explorer: 'https://sepolia.etherscan.io', contract: '' },
    137:      { name: 'Polygon',        rpc: ['https://polygon-rpc.com'], currency: { name: 'POL', symbol: 'POL', decimals: 18 }, explorer: 'https://polygonscan.com', contract: '' },
  },
  assets: { images: 'nft/images', json: 'nft/json', rarity: 'nft/rarity.json', collection: 'nft/collection.json' },
};
