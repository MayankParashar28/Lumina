/**
 * Syntax highlighting for code in published posts.
 *
 * Quill stores a code block as a bare <pre class="ql-syntax"> with no language
 * information and no markup inside it, so highlighting happens here, at render
 * time, rather than being written into the document. Three reasons:
 *
 *   - the stored HTML stays plain, so the database holds text rather than a
 *     few hundred <span> tags per block;
 *   - every post already published gets highlighted too, with no migration;
 *   - the sanitiser never has to decide whether a highlighter's markup is safe.
 *
 * Language is detected rather than declared, because the editor has nowhere to
 * declare it. Detection is unreliable on very short snippets, so anything under
 * a few words is left unhighlighted instead of being guessed at and mislabelled.
 */
(function () {
  "use strict";

  var MIN_CHARS = 12;       // below this, detection is a coin toss
  var MAX_CHARS = 100000;   // above this, highlighting janks the main thread

  // highlight.js scores each candidate language; low scores mean it is guessing.
  // Labelling a shell command "Markdown" is worse than showing no label, so the
  // colours are applied either way but the badge only appears above this score.
  var LABEL_MIN_RELEVANCE = 5;

  var PRETTY = {
    js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
    py: "Python", python: "Python", rb: "Ruby", ruby: "Ruby", go: "Go", rust: "Rust",
    java: "Java", kotlin: "Kotlin", swift: "Swift", php: "PHP", cs: "C#", csharp: "C#",
    cpp: "C++", c: "C", sql: "SQL", bash: "Bash", shell: "Shell", sh: "Shell",
    json: "JSON", yaml: "YAML", xml: "XML", html: "HTML", css: "CSS", scss: "SCSS",
    dockerfile: "Dockerfile", markdown: "Markdown", plaintext: "Text"
  };

  function label(name) {
    if (!name) return null;
    return PRETTY[name.toLowerCase()] || name.charAt(0).toUpperCase() + name.slice(1);
  }

  function enhance(root) {
    if (!window.hljs) return;
    var scope = root || document;
    var blocks = scope.querySelectorAll("pre.ql-syntax, .ql-editor pre, .blog-body pre, article pre");

    Array.prototype.forEach.call(blocks, function (pre) {
      if (pre.dataset._highlighted) return;
      pre.dataset._highlighted = "1";

      var source = pre.textContent || "";
      if (source.length < MIN_CHARS || source.length > MAX_CHARS) return;

      var result;
      try {
        result = window.hljs.highlightAuto(source);
      } catch (e) {
        return; // a failed guess must never break the article
      }
      if (!result || !result.value) return;

      // Replace only the code text. Any copy button already appended by app.js
      // lives alongside it and must survive.
      var holder = document.createElement("code");
      holder.className = "hljs";
      holder.innerHTML = result.value;

      var button = pre.querySelector(".code-copy-btn");
      pre.textContent = "";
      pre.appendChild(holder);
      if (button) pre.appendChild(button);

      pre.classList.add("hljs-block");

      if (result.language && (result.relevance || 0) >= LABEL_MIN_RELEVANCE) {
        pre.setAttribute("data-lang", label(result.language));
      }
    });
  }

  window.enhanceCodeBlocks = enhance;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { enhance(); });
  } else {
    enhance();
  }
})();
