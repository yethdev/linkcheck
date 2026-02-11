// Parses raw bot text + embeds into structured per-platform results.
// The bot outputs alternating lines: platform name, then "Category - Likely Blocked (took 123ms)".
// Also handles compact single-line format: "Name: Category - Detail (took Xms)".

export function parseBotResponse(reply) {
  const raw = [reply.text, ...reply.embeds].join('\n');

  // The data repeats multiple times in the raw output.
  // Look for the cleanest section: lines that alternate name / result.
  // Find lines that match the result pattern: "Something -  Likely Unblocked (took 123ms)"
  const allLines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  // Deduplicate: find the section with individual newline-separated pairs
  // These appear later in the output and are the cleanest
  const resultLinePattern = /^.+\s+-\s+.+\(took\s+\d+ms\)$/;
  const loadingPattern = /loading|⏳/i;
  const errorPattern = /error|⚠️|report to/i;
  const notePattern = /all checkers use the default settings/i;
  const headerPattern = /^results for /i;

  // --- Compact single-line pattern ---
  // Matches: "Name: Category - Detail (took Xms)"  or  "Name — Category - Detail (took Xms)"
  // Also handles leading emojis / decorators like "✅ Name: ..."
  const compactLinePattern = /^[^\w]*(.+?)\s*[:—]\s+(.+?)\s+-\s+(.+?)\s*\(took\s+(\d+)ms\)$/;

  // Collect name/result pairs — scan for lines where:
  //   line N = platform name (no " - " and no "took")
  //   line N+1 = result line (has " - " and "took")
  const platforms = [];
  const seen = new Set(); // deduplicate by platform name
  let note = null;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];

    // Capture the note
    if (notePattern.test(line)) {
      note = line.replace(/^[^\w]*/, '').trim();
      continue;
    }

    // Skip "Results for ..." header
    if (headerPattern.test(line)) continue;

    // Check if this is a platform name followed by a result line
    const nextLine = allLines[i + 1];
    if (!nextLine) {
      tryCompactLine(line, platforms, seen, compactLinePattern, loadingPattern, errorPattern);
      continue;
    }

    const isNameLine = !line.includes(' - ') && !line.includes('(took') && !notePattern.test(line) && !headerPattern.test(line);
    const isResultLine = nextLine.includes(' - ') && nextLine.includes('(took');
    const isLoadingNext = loadingPattern.test(nextLine) && !nextLine.includes('(took');
    const isErrorNext = errorPattern.test(nextLine) && !nextLine.includes('(took');

    if (isNameLine && (isResultLine || isLoadingNext || isErrorNext)) {
      const name = line.trim();

      // Skip duplicates
      if (seen.has(name)) { i++; continue; }
      seen.add(name);

      if (isLoadingNext) {
        platforms.push({
          name,
          category: 'Loading...',
          status: 'loading',
          detail: 'Loading...',
          ms: null,
          icon: '⏳',
        });
        i++; // skip the result line
        continue;
      }

      if (isErrorNext) {
        platforms.push({
          name,
          category: nextLine.trim(),
          status: 'error',
          detail: nextLine.trim(),
          ms: null,
          icon: '⚠️',
        });
        i++; // skip the result line
        continue;
      }

      // Parse the result line: "Category -  Likely Unblocked (took 123ms)"
      const resultMatch = nextLine.match(
        /^(.+?)\s+-\s+(.+?)\s*\(took\s+(\d+)ms\)$/
      );

      if (resultMatch) {
        const category = resultMatch[1].trim();
        const detail = resultMatch[2].trim();
        const ms = parseInt(resultMatch[3], 10);

        let status = 'unknown';
        if (detail.toLowerCase().includes('unblocked')) {
          status = 'unblocked';
        } else if (detail.toLowerCase().includes('blocked')) {
          status = 'blocked';
        }

        platforms.push({ name, category, status, detail, ms, icon: '' });
      }

      i++; // skip the result line
    } else {
      tryCompactLine(line, platforms, seen, compactLinePattern, loadingPattern, errorPattern);
    }
  }

  // Fallback: if we got very few results with the above, do a broad sweep
  // for any line containing "(took Xms)" that we haven't captured yet
  if (platforms.filter(p => p.status !== 'loading').length < 5) {
    for (const line of allLines) {
      if (!line.includes('(took')) continue;
      if (notePattern.test(line) || headerPattern.test(line)) continue;
      tryCompactLine(line, platforms, seen, compactLinePattern, loadingPattern, errorPattern);
      // Also try a broader pattern: "anything (took Xms)" where the first word is the name
      if (!seen.has(line.split(/\s*[-:—]\s/)[0]?.trim())) {
        const broadMatch = line.match(/^[^\w]*(.+?)\s+-\s+(.+?)\s*\(took\s+(\d+)ms\)$/);
        if (broadMatch) {
          // Try to split at the LAST " - " before "(took"
          const beforeTook = line.replace(/\s*\(took\s+\d+ms\)$/, '');
          const dashParts = beforeTook.split(/\s+-\s+/);
          if (dashParts.length >= 3) {
            const name = dashParts[0].replace(/^[^\w]*/, '').trim();
            if (seen.has(name)) continue;
            seen.add(name);
            const category = dashParts[1].trim();
            const detail = dashParts.slice(2).join(' - ').trim();
            const msMatch = line.match(/\(took\s+(\d+)ms\)/);
            const ms = msMatch ? parseInt(msMatch[1], 10) : null;
            let status = 'unknown';
            if (detail.toLowerCase().includes('unblocked')) status = 'unblocked';
            else if (detail.toLowerCase().includes('blocked')) status = 'blocked';
            platforms.push({ name, category, status, detail, ms, icon: '' });
          }
        }
      }
    }
  }

  return { platforms, note, raw };
}

function tryCompactLine(line, platforms, seen, compactLinePattern, loadingPattern, errorPattern) {
  const m = line.match(compactLinePattern);
  if (!m) return;
  const name = m[1].replace(/^[^\w]*/, '').trim();
  if (seen.has(name)) return;
  seen.add(name);
  const category = m[2].trim();
  const detail = m[3].trim();
  const ms = parseInt(m[4], 10);
  let status = 'unknown';
  if (detail.toLowerCase().includes('unblocked')) status = 'unblocked';
  else if (detail.toLowerCase().includes('blocked')) status = 'blocked';
  platforms.push({ name, category, status, detail, ms, icon: '' });
}
