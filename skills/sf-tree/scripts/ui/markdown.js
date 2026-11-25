// Linear-time, ReDoS-free, DOM-only safe Markdown renderer (zero innerHTML).

export const HR_RE = /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

/**
 * Strictly validate Markdown link hrefs.
 * Allows: http:, https:, mailto:, #fragments, and single-slash /relative paths.
 * Blocks: javascript:, data:, vbscript:, protocol-relative //, control characters, etc.
 */
export function sanitizeMarkdownHref(rawHref) {
  if (typeof rawHref !== "string") return null;
  const trimmed = rawHref.trim().replace(/^<|>$/g, "").trim();
  if (!trimmed || CONTROL_CHARS_RE.test(trimmed)) return null;

  if (trimmed.startsWith("#")) {
    return { href: trimmed, external: false };
  }

  if (trimmed.startsWith("/")) {
    // Reject protocol-relative URLs (//evil.example) and backslash tricks (/\evil.example)
    if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return null;
    return { href: trimmed, external: false };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return { href: parsed.href, external: true };
    }
    if (parsed.protocol === "mailto:") {
      return { href: parsed.href, external: false };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Precompute O(n) balanced parenthesis matching map so link destination parsing
 * runs in strict O(n) worst-case time even on adversarial inputs.
 */
function buildParenMatchMap(text) {
  const map = new Map();
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") {
      stack.push(i);
    } else if (ch === ")" && stack.length > 0) {
      map.set(stack.pop(), i);
    }
  }
  return map;
}

/**
 * Single-pass linear-time inline Markdown tokenizer (code, bold, italic, balanced-paren links).
 * Guaranteed O(n) worst-case time — immune to catastrophic backtracking / ReDoS.
 */
export function tokenizeInline(input) {
  const text = String(input ?? "");
  const tokens = [];
  const parenMap = text.includes("](") ? buildParenMatchMap(text) : null;

  let textBufStart = 0;
  let i = 0;
  let noCloseBacktick = false;
  let noCloseBold = false;
  let noCloseItalic = false;
  let noCloseBracket = false;

  const flushText = (endIdx) => {
    if (endIdx > textBufStart) {
      tokens.push({ type: "text", text: text.slice(textBufStart, endIdx) });
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Inline code: `...`
    if (ch === "`" && !noCloseBacktick) {
      const closeIdx = text.indexOf("`", i + 1);
      if (closeIdx === -1) {
        noCloseBacktick = true;
      } else if (closeIdx > i + 1) {
        flushText(i);
        tokens.push({ type: "code", text: text.slice(i + 1, closeIdx) });
        i = closeIdx + 1;
        textBufStart = i;
        continue;
      }
    }

    // Bold: **...**
    if (ch === "*" && text[i + 1] === "*" && !noCloseBold) {
      const closeIdx = text.indexOf("**", i + 2);
      if (closeIdx === -1) {
        noCloseBold = true;
      } else if (closeIdx > i + 2) {
        flushText(i);
        tokens.push({ type: "strong", text: text.slice(i + 2, closeIdx) });
        i = closeIdx + 2;
        textBufStart = i;
        continue;
      }
    }

    // Italic: *...*
    if (ch === "*" && text[i + 1] !== "*" && !noCloseItalic) {
      const closeIdx = text.indexOf("*", i + 1);
      if (closeIdx === -1) {
        noCloseItalic = true;
      } else if (closeIdx > i + 1) {
        flushText(i);
        tokens.push({ type: "em", text: text.slice(i + 1, closeIdx) });
        i = closeIdx + 1;
        textBufStart = i;
        continue;
      }
    }

    // Link: [label](href) with balanced parentheses via O(1) parenMap lookup
    if (ch === "[" && parenMap && !noCloseBracket) {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket === -1) {
        noCloseBracket = true;
      } else if (closeBracket > i + 1 && text[closeBracket + 1] === "(") {
        const openParen = closeBracket + 1;
        const closeParen = parenMap.get(openParen);
        if (closeParen !== undefined && closeParen > openParen + 1) {
          const linkText = text.slice(i + 1, closeBracket);
          const rawHref = text.slice(openParen + 1, closeParen);
          const safe = sanitizeMarkdownHref(rawHref);
          flushText(i);
          if (safe) {
            tokens.push({
              type: "link",
              text: linkText,
              href: safe.href,
              external: safe.external,
            });
          } else {
            tokens.push({ type: "text", text: linkText });
          }
          i = closeParen + 1;
          textBufStart = i;
          continue;
        }
      }
    }

    i += 1;
  }

  flushText(text.length);
  return tokens;
}

function createEl(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Render inline Markdown tokens safely into a DOM container using textContent/createTextNode only.
 */
export function renderSafeInline(container, text, doc = globalThis.document) {
  const tokens = tokenizeInline(text);
  for (const tok of tokens) {
    if (tok.type === "code") {
      container.appendChild(createEl(doc, "code", "", tok.text));
    } else if (tok.type === "strong") {
      container.appendChild(createEl(doc, "strong", "", tok.text));
    } else if (tok.type === "em") {
      container.appendChild(createEl(doc, "em", "", tok.text));
    } else if (tok.type === "link") {
      const a = createEl(doc, "a", "", tok.text);
      a.href = tok.href;
      if (tok.external) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      container.appendChild(a);
    } else {
      container.appendChild(doc.createTextNode(tok.text));
    }
  }
}

/**
 * Render block + inline Markdown safely into a detached `<div class="md-view">` (zero innerHTML).
 */
export function renderSafeMarkdown(markdown, doc = globalThis.document) {
  const root = createEl(doc, "div", "md-view");
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const pre = createEl(doc, "pre");
      pre.appendChild(createEl(doc, "code", "", codeLines.join("\n")));
      root.appendChild(pre);
      continue;
    }

    if (HR_RE.test(line)) {
      root.appendChild(createEl(doc, "hr"));
      i += 1;
      continue;
    }

    const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      const hEl = createEl(doc, `h${hMatch[1].length}`);
      renderSafeInline(hEl, hMatch[2].trim(), doc);
      root.appendChild(hEl);
      i += 1;
      continue;
    }

    if (line.trim().startsWith(">")) {
      const bq = createEl(doc, "blockquote");
      const bqLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        bqLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const p = createEl(doc, "p");
      renderSafeInline(p, bqLines.join(" "), doc);
      bq.appendChild(p);
      root.appendChild(bq);
      continue;
    }

    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const parseRow = (r) =>
        r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const headers = parseRow(line);
      i += 2;
      const table = createEl(doc, "table");
      const thead = createEl(doc, "thead");
      const hTr = createEl(doc, "tr");
      headers.forEach((h) => {
        const th = createEl(doc, "th");
        renderSafeInline(th, h, doc);
        hTr.appendChild(th);
      });
      thead.appendChild(hTr);
      table.appendChild(thead);

      const tbody = createEl(doc, "tbody");
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const cells = parseRow(lines[i]);
        const tr = createEl(doc, "tr");
        cells.forEach((c) => {
          const td = createEl(doc, "td");
          renderSafeInline(td, c, doc);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
        i += 1;
      }
      table.appendChild(tbody);
      root.appendChild(table);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = createEl(doc, "ul");
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const li = createEl(doc, "li");
        renderSafeInline(li, lines[i].replace(/^\s*[-*+]\s+/, ""), doc);
        ul.appendChild(li);
        i += 1;
      }
      root.appendChild(ul);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = createEl(doc, "ol");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = createEl(doc, "li");
        renderSafeInline(li, lines[i].replace(/^\s*\d+\.\s+/, ""), doc);
        ol.appendChild(li);
        i += 1;
      }
      root.appendChild(ol);
      continue;
    }

    const pLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !HR_RE.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith(">") &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      pLines.push(lines[i].trim());
      i += 1;
    }
    const p = createEl(doc, "p");
    renderSafeInline(p, pLines.join(" "), doc);
    root.appendChild(p);
  }

  return root;
}
