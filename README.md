# RETAIL

Your first trade is on the house. Put a code in your X bio, paste your wallet, get $20 in SOL. Every payout prints a receipt on-chain.

- Settings: `api/_config.js` (CA, payout wallet, X handle, amount, daily cap, rules)
- Storage: a private Vercel Blob store connected to this project (`BLOB_READ_WRITE_TOKEN`)
- Payouts: `/till`, signed in with the payout wallet. Each payment is approved in your wallet and checked on-chain. No keys on the server.
