// Spam / toxicity risk scoring for comments and accounts.
//
// A transparent, feature-based score rather than a black box: every point of
// risk comes with a human-readable reason, so a moderator can see *why* a
// comment was held, and a false positive is easy to diagnose. Signals are
// combined with a logistic squash so no single weak signal decides alone, but
// several together do.

const SPAM_PHRASES = [
  /\b(buy|cheap|discount|promo(?:tion)?|coupon|free\s+trial)\b/i,
  /\b(crypto|bitcoin|forex|binary\s+options?|airdrop|nft\s+drop)\b/i,
  /\b(casino|betting|slot\s+machine|jackpot)\b/i,
  /\b(seo\s+services?|backlinks?|guest\s+post(?:ing)?|increase\s+(?:your\s+)?traffic)\b/i,
  /\b(work\s+from\s+home|earn\s+\$?\d+|make\s+money\s+(?:fast|online))\b/i,
  /\b(whats\s?app|telegram)\s*(?:me|us|\+?\d)/i,
  /\b(click\s+(?:here|the\s+link)|check\s+(?:out\s+)?my\s+(?:profile|channel|site))\b/i,
  /\b(dm\s+me|follow\s+for\s+follow|f4f|sub4sub)\b/i,
];

// Hostility aimed at a person. The profanity list in utils/moderator.js
// catches swearing; these look for attacks. Rudeness is held for a human to
// look at; threats and self-harm baiting are blocked outright.
const INSULTS = [
  /\b(you(?:'re|\s+are)\s+(?:an?\s+|so\s+)?(?:idiot|moron|stupid|dumb|pathetic|loser|worthless|trash|garbage|clown))\b/i,
  /\b(shut\s+up|nobody\s+asked|get\s+lost|go\s+away\s+loser)\b/i,
];
const THREATS = [
  /\b(kill\s+yourself|kys|go\s+die|hope\s+you\s+die)\b/i,
  /\b(i(?:'ll|\s+will|\s+am\s+going\s+to)\s+(?:find|hurt|kill|beat)\s+you)\b/i,
];

const URL_RE = /\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+|\b[a-z0-9-]+\.(?:com|net|org|io|xyz|top|biz|info|ru|cn|ly|me)\b(?:\/[^\s<>"]*)?/gi;
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rb\.gy|shorturl\.at)\b/i;

const squash = (x) => 1 / (1 + Math.exp(-x));

function linksIn(text) {
  return String(text || "").match(URL_RE) || [];
}

/**
 * @param {object} c
 * @param {string} c.text
 * @param {number} [c.accountAgeDays]
 * @param {boolean} [c.isVerified]
 * @param {number} [c.recentCount]     this user's comments in the last 10 minutes
 * @param {number} [c.duplicateCount]  identical comments by this user elsewhere (last 7 days)
 * @returns {{ score:number, level:"low"|"review"|"block", reasons:string[] }}
 */
function scoreComment({ text = "", accountAgeDays = 365, isVerified = true, recentCount = 0, duplicateCount = 0 } = {}) {
  const t = String(text);
  const plain = t.replace(/<[^>]*>/g, " ");
  const reasons = [];
  let x = -4; // baseline: most comments are fine

  const links = linksIn(plain);
  if (links.length) {
    x += 1.2 + 0.8 * Math.min(links.length - 1, 4);
    reasons.push(links.length === 1 ? "Contains a link" : `Contains ${links.length} links`);
  }
  if (links.some((l) => SHORTENERS.test(l))) {
    x += 1.5;
    reasons.push("Uses a link shortener");
  }

  const spamHits = SPAM_PHRASES.filter((re) => re.test(plain)).length;
  if (spamHits) {
    x += 1.6 * spamHits;
    reasons.push(spamHits === 1 ? "Promotional wording" : `Promotional wording (${spamHits} kinds)`);
  }

  const insultHits = INSULTS.filter((re) => re.test(plain)).length;
  if (insultHits) {
    x += 4 + 1.5 * (insultHits - 1); // one insult alone lands on "review"
    reasons.push("Insulting language");
  }
  const threatHits = THREATS.filter((re) => re.test(plain)).length;
  if (threatHits) {
    x += 7;
    reasons.push("Threatening language");
  }
  const hostileHits = insultHits + threatHits;

  const letters = plain.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 20) {
    const caps = letters.replace(/[^A-Z]/g, "").length / letters.length;
    if (caps > 0.7) {
      x += 1.2;
      reasons.push("Mostly capital letters");
    }
  }
  if (/(.)\1{7,}/.test(plain) || /(\b\w+\b)(?:\W+\1\b){4,}/i.test(plain)) {
    x += 1;
    reasons.push("Repeated characters or words");
  }
  if (/[\u{1F300}-\u{1FAFF}]/u.test(plain) && (plain.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length > 12) {
    x += 0.8;
    reasons.push("Emoji flood");
  }

  if (duplicateCount > 0) {
    x += 1.5 + 0.7 * Math.min(duplicateCount, 5);
    reasons.push(`Same comment posted ${duplicateCount + 1} times`);
  }
  if (recentCount >= 5) {
    x += 0.6 * Math.min(recentCount - 4, 6);
    reasons.push(`${recentCount} comments in 10 minutes`);
  }
  if (accountAgeDays < 1) {
    x += 1;
    reasons.push("Account less than a day old");
  } else if (accountAgeDays < 7) {
    x += 0.4;
  }
  if (!isVerified) {
    x += 0.6;
    reasons.push("Email not verified");
  }
  // Context only amplifies content signals: a new account saying something
  // normal is fine.
  if (!links.length && !spamHits && !hostileHits && !duplicateCount) x = Math.min(x, -1.5);

  const score = Math.round(squash(x) * 100) / 100;
  const level = score >= 0.85 ? "block" : score >= 0.5 ? "review" : "low";
  return { score, level, reasons };
}

/**
 * Account-level risk from recent behaviour (spam / bot accounts).
 * @returns {{ score:number, level:"low"|"watch"|"high", reasons:string[] }}
 */
function scoreAccount({
  accountAgeDays = 365,
  isVerified = true,
  followsLastHour = 0,
  commentsLastDay = 0,
  linkCommentsLastDay = 0,
  duplicateComments = 0,
  flaggedComments = 0,
  postsLastDay = 0,
} = {}) {
  const reasons = [];
  let x = -4;
  if (followsLastHour >= 30) {
    x += 1 + Math.min((followsLastHour - 30) / 20, 3);
    reasons.push(`Followed ${followsLastHour} people in an hour`);
  }
  if (commentsLastDay >= 30) {
    x += 1 + Math.min((commentsLastDay - 30) / 30, 2);
    reasons.push(`${commentsLastDay} comments in a day`);
  }
  if (linkCommentsLastDay >= 3) {
    x += 1.2 + 0.3 * Math.min(linkCommentsLastDay - 3, 5);
    reasons.push(`${linkCommentsLastDay} comments with links in a day`);
  }
  if (duplicateComments >= 2) {
    x += 1.5 + 0.4 * Math.min(duplicateComments - 2, 5);
    reasons.push(`Posted the same comment ${duplicateComments} times`);
  }
  if (flaggedComments >= 1) {
    x += 1.2 * Math.min(flaggedComments, 4);
    reasons.push(`${flaggedComments} comment${flaggedComments === 1 ? "" : "s"} held or blocked`);
  }
  if (postsLastDay >= 10) {
    x += 1.5;
    reasons.push(`${postsLastDay} posts in a day`);
  }
  if (reasons.length && accountAgeDays < 3) {
    x += 1;
    reasons.push("New account");
  }
  if (reasons.length && !isVerified) {
    x += 0.7;
    reasons.push("Email not verified");
  }
  const score = Math.round(squash(x) * 100) / 100;
  const level = score >= 0.8 ? "high" : score >= 0.45 ? "watch" : "low";
  return { score, level, reasons };
}

module.exports = { scoreComment, scoreAccount, linksIn };
