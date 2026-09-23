// Email body cleanup — ported unchanged from worker.js.

function htmlToText(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tidy(text) {
  const t = (text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > 4000 ? t.slice(0, 4000) + "\n\n[truncated]" : t;
}

// Tier 1: strip [cid:...] refs. Tier 2: "-- " delimiter and "Sent from my ..."
// footers. Tier 3: conservative Outlook-style signature detection.
function cleanEmailBody(text, fromName, fromAddr) {
  let t = (text || "").replace(/\r/g, "");
  t = t.replace(/\[cid:[^\]]*\]/gi, "");
  const rfc = t.search(/^--[ \t]*$/m);
  if (rfc !== -1) t = t.slice(0, rfc);
  t = t.replace(/^sent from my [^\n]{0,60}$/gim, "");

  const nameNorm = (fromName || "").trim().replace(/\s+/g, " ").toLowerCase();
  const addrNorm = (fromAddr || "").trim().toLowerCase();
  const looksLikeName = nameNorm && nameNorm !== addrNorm && !nameNorm.includes("@");
  if (looksLikeName) {
    const lines = t.split("\n");
    const phoneRe = /\+?\d[\d\s().,-]{6,}\d/;
    const siteRe = /(www\.|https?:\/\/)[^\s]+/i;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim().replace(/\s+/g, " ").toLowerCase() !== nameNorm) continue;
      const tail = lines.slice(i + 1, i + 7).join("\n").toLowerCase();
      if (phoneRe.test(tail) || siteRe.test(tail) || (addrNorm.includes("@") && tail.includes(addrNorm))) {
        const kept = lines.slice(0, i).join("\n").trim();
        if (kept.length >= 12) t = kept;
        break;
      }
    }
  }
  return t;
}

module.exports = { htmlToText, tidy, cleanEmailBody };
