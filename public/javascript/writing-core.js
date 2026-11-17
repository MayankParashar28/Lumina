/*
 * Writing assistant core: readability and style analysis plus a headline
 * score. Runs in the browser on every pause in typing (no server, no cost) and
 * in Node for tests — so it is plain ES5-ish code with a UMD wrapper.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LuminaWriting = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- tokenising ----------
  function sentencesOf(text) {
    var cleaned = String(text || "").replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    // Split on . ! ? followed by space + capital/quote/digit, keeping common abbreviations together.
    var protectedText = cleaned
      .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|U\.S)\./gi, function (m) { return m.replace(/\./g, "․"); })
      // Decimals and version numbers ("3.5", "v2.1") aren't sentence ends.
      .replace(/(\d)\.(\d)/g, "$1․$2");
    // A sentence: text up to . ! ? (plus closing quotes/brackets), or the end.
    var parts = protectedText.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || [];
    return parts.map(function (s) { return s.replace(/․/g, ".").trim(); }).filter(Boolean);
  }

  function wordsOf(text) {
    return String(text || "").match(/[A-Za-zÀ-ɏ]+(?:['’-][A-Za-zÀ-ɏ]+)*|\d+(?:[.,]\d+)*/g) || [];
  }

  // Syllable estimate good enough for readability formulas.
  function syllables(word) {
    var w = String(word).toLowerCase().replace(/[^a-z]/g, "");
    if (!w) return 0;
    if (w.length <= 3) return 1;
    w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
    var groups = w.match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  // ---------- style rules ----------
  var WEAK_ADVERBS = /\b(very|really|extremely|totally|completely|absolutely|literally|basically|actually|quite|rather|somewhat|just|simply)\b/gi;
  var PASSIVE = /\b(am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?(\w+(?:ed|en)|built|made|done|seen|known|given|taken|written|found|told|thought|shown|held|kept|left|lost|paid|put|read|run|said|sent|set|sold|spent|taught|understood|won)\b/gi;
  var FILLERS = [
    [/\bin order to\b/gi, "to"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bat this point in time\b/gi, "now"],
    [/\bin the event that\b/gi, "if"],
    [/\bhas the ability to\b/gi, "can"],
    [/\bfor the purpose of\b/gi, "for"],
    [/\bit is important to note that\b/gi, "(cut it)"],
    [/\bneedless to say\b/gi, "(cut it)"],
    [/\ba large number of\b/gi, "many"],
    [/\bin spite of the fact that\b/gi, "although"],
  ];
  var STOP = { the: 1, a: 1, an: 1, and: 1, or: 1, but: 1, of: 1, to: 1, in: 1, on: 1, for: 1, with: 1, is: 1, are: 1, was: 1, were: 1, it: 1, this: 1, that: 1, i: 1, you: 1, we: 1, they: 1, he: 1, she: 1, be: 1, as: 1, at: 1, by: 1, from: 1, have: 1, has: 1, not: 1, your: 1, my: 1, our: 1, can: 1, will: 1, if: 1, so: 1, do: 1, more: 1, all: 1 };

  function snippet(s, max) {
    max = max || 90;
    return s.length > max ? s.slice(0, max - 1).trim() + "…" : s;
  }

  function gradeLabel(ease) {
    if (ease >= 80) return "Very easy";
    if (ease >= 65) return "Easy";
    if (ease >= 50) return "Fairly easy";
    if (ease >= 35) return "Fairly difficult";
    if (ease >= 20) return "Difficult";
    return "Very difficult";
  }

  /**
   * analyze(plainText) → stats + a list of issues, each with a type, message
   * and (where useful) the sentence it is about.
   */
  function analyze(text) {
    var plain = String(text || "");
    var sents = sentencesOf(plain);
    var words = wordsOf(plain);
    var wc = words.length;
    var syl = 0;
    var complex = 0;
    for (var i = 0; i < words.length; i++) {
      var s = syllables(words[i]);
      syl += s;
      if (s >= 3 && !/^[A-Z]/.test(words[i])) complex++;
    }
    var sc = Math.max(1, sents.length);
    var wps = wc / sc;
    var spw = wc ? syl / wc : 0;
    // Flesch reading ease and Flesch–Kincaid grade.
    var ease = wc ? Math.max(0, Math.min(100, 206.835 - 1.015 * wps - 84.6 * spw)) : 0;
    var grade = wc ? Math.max(0, 0.39 * wps + 11.8 * spw - 15.59) : 0;

    var issues = [];

    sents.forEach(function (s) {
      var n = wordsOf(s).length;
      if (n >= 35) issues.push({ type: "long-sentence", severity: "high", message: "Very long sentence (" + n + " words). Try splitting it.", quote: snippet(s) });
      else if (n >= 25) issues.push({ type: "long-sentence", severity: "medium", message: "Long sentence (" + n + " words).", quote: snippet(s) });
    });

    var passive = [];
    sents.forEach(function (s) {
      PASSIVE.lastIndex = 0;
      var m = PASSIVE.exec(s);
      if (m) passive.push({ quote: snippet(s), phrase: m[0] });
    });
    if (passive.length && passive.length / sc > 0.1) {
      passive.slice(0, 5).forEach(function (p) {
        issues.push({ type: "passive", severity: "low", message: "Passive voice: “" + p.phrase + "”. Active voice is usually clearer.", quote: p.quote });
      });
    }

    var adverbs = plain.match(WEAK_ADVERBS) || [];
    if (wc && adverbs.length / wc > 0.015) {
      var counts = {};
      adverbs.forEach(function (a) { var k = a.toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
      var list = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 4);
      issues.push({ type: "adverbs", severity: "low", message: "Weak intensifiers used " + adverbs.length + " times (" + list.map(function (k) { return "“" + k + "” ×" + counts[k]; }).join(", ") + "). A stronger word often works better." });
    }

    FILLERS.forEach(function (f) {
      var m = plain.match(f[0]);
      if (m) issues.push({ type: "wordy", severity: "low", message: "“" + m[0] + "” → " + f[1] + (m.length > 1 ? " (" + m.length + "×)" : "") });
    });

    // Overused content words (excluding stopwords), relative to length.
    if (wc >= 150) {
      var freq = {};
      words.forEach(function (w) {
        var k = w.toLowerCase();
        if (k.length < 4 || STOP[k]) return;
        freq[k] = (freq[k] || 0) + 1;
      });
      Object.keys(freq)
        .filter(function (k) { return freq[k] / wc > 0.02 && freq[k] >= 6; })
        .sort(function (a, b) { return freq[b] - freq[a]; })
        .slice(0, 3)
        .forEach(function (k) {
          issues.push({ type: "repetition", severity: "low", message: "“" + k + "” appears " + freq[k] + " times. Consider a synonym in places." });
        });
    }

    // Wall-of-text paragraphs.
    var paragraphs = plain.split(/\n{2,}|\r\n\r\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    paragraphs.forEach(function (p) {
      var n = wordsOf(p).length;
      if (n > 180) issues.push({ type: "paragraph", severity: "medium", message: "Long paragraph (" + n + " words). Break it up for easier reading on phones.", quote: snippet(p) });
    });

    var order = { high: 0, medium: 1, low: 2 };
    issues.sort(function (a, b) { return order[a.severity] - order[b.severity]; });

    return {
      words: wc,
      sentences: sents.length,
      paragraphs: paragraphs.length,
      readingMinutes: Math.max(1, Math.round(wc / 200)),
      avgSentenceLength: Math.round(wps * 10) / 10,
      readingEase: Math.round(ease),
      readingLevel: gradeLabel(ease),
      grade: Math.round(grade * 10) / 10,
      complexWordShare: wc ? Math.round((complex / wc) * 100) : 0,
      passiveCount: passive.length,
      issues: issues,
    };
  }

  // ---------- headline score ----------
  var POWER = /\b(how|why|what|guide|lessons?|mistakes?|secrets?|truth|simple|easy|proven|ultimate|complete|essential|surprising|best|worst|never|always|stop|start|everything|nobody|finally|actually|real|honest)\b/i;
  var EMOTION = /\b(love|hate|fear|afraid|amazing|beautiful|brutal|painful|joy|happy|sad|angry|shocking|incredible|powerful|dangerous|broke|failed|quit|regret)\b/i;
  var VAGUE = /\b(thoughts?|musings?|update|random|stuff|things|untitled|my\s+blog|post)\b/i;

  /**
   * headlineScore(title) → { score 0-100, label, tips[] }
   * A heuristic estimate of how clear and clickable a title is, based on
   * patterns that tend to work for articles: specific length, a number or a
   * question, a concrete promise, and no clickbait shouting.
   */
  function headlineScore(title) {
    var t = String(title || "").trim();
    var tips = [];
    if (!t) return { score: 0, label: "Add a title", tips: ["Write a title to see its score."] };
    var w = wordsOf(t);
    var n = w.length;
    var score = 50;

    if (n >= 6 && n <= 12) score += 15;
    else if (n >= 4 && n <= 14) score += 6;
    else if (n < 4) { score -= 12; tips.push("Very short. Say what the reader gets (6–12 words works well)."); }
    else { score -= 10; tips.push("Long title. Cut it to 12 words or fewer so it isn't truncated in feeds."); }

    if (t.length > 70) { score -= 6; tips.push("Over 70 characters — search results will cut it off."); }

    if (/\d/.test(t)) score += 8;
    else tips.push("A number (“5 lessons”, “in 10 minutes”) makes the promise concrete.");

    if (/\?$/.test(t) || /^(how|why|what|when|which|should|can|is|are|do|does)\b/i.test(t)) score += 7;
    if (POWER.test(t)) score += 7;
    else tips.push("Try a clear promise word: how, why, guide, lessons, mistakes.");
    if (EMOTION.test(t)) score += 5;
    if (/\b(you|your)\b/i.test(t)) score += 4;
    if (/:|—|\s-\s/.test(t)) score += 3; // "Topic: the angle" structure

    if (VAGUE.test(t)) { score -= 10; tips.push("Vague words (thoughts, update, stuff) don't tell readers why to click."); }
    var letters = t.replace(/[^A-Za-z]/g, "");
    if (letters.length > 8 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6) { score -= 15; tips.push("Avoid ALL CAPS — it reads as shouting."); }
    if (/!{2,}|\?{2,}/.test(t)) { score -= 8; tips.push("One punctuation mark is enough."); }
    if (/\b(you won'?t believe|shocking truth|doctors hate)\b/i.test(t)) { score -= 15; tips.push("Clickbait phrasing hurts trust."); }

    score = Math.max(0, Math.min(100, Math.round(score)));
    var label = score >= 80 ? "Strong" : score >= 65 ? "Good" : score >= 45 ? "Okay" : "Weak";
    return { score: score, label: label, tips: tips.slice(0, 3) };
  }

  return { analyze: analyze, headlineScore: headlineScore, sentencesOf: sentencesOf, wordsOf: wordsOf, syllables: syllables };
});
