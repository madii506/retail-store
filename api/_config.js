// RETAIL store settings. This file is the only place to change them.
// Fill ca / payout / x at launch and redeploy. Empty means "not set yet" and the site shows a dash.
module.exports = {
  name: 'RETAIL',
  ticker: '$RETAIL',
  ca: '',          // token mint address (pump.fun) once it exists
  payout: '',      // public payout wallet (the creator wallet that receives fees). Only this wallet can open /till.
  x: '',           // X handle of the project, without @

  amountUsd: 20,   // paid in SOL at the price when it's sent
  dailyCap: 500,   // claims accepted per UTC day
  open: true,      // set false to pause new claims

  // who can claim (checked on the public X profile)
  minAgeDays: 30,
  minFollowers: 10,
  minPosts: 5,
  maxWalletTxs: 10, // "first-timer" wallet: at most this many past transactions (0 = don't check)
  perIpPerDay: 2,
};
