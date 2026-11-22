const CJK_TERM_CHAR_RE =
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{2ebf0}-\u{2ee5f}\u{2f800}-\u{2fa1f}\u{30000}-\u{3134f}\u{31350}-\u{323af}\u{323b0}-\u{3347f}]/u;

const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}]/u;

function isAscii(text: string): boolean {
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) > 127) return false;
	}
	return true;
}

function harnessQueryRuns(text: string): string[] {
	const runs: string[] = [];
	let run: string[] = [];
	let runIsCjk = false;
	for (const ch of text) {
		if (WORD_CHAR_RE.test(ch)) {
			const chIsCjk = CJK_TERM_CHAR_RE.test(ch);
			if (run.length > 0 && chIsCjk !== runIsCjk) {
				runs.push(run.join(""));
				run = [];
			}
			runIsCjk = chIsCjk;
			run.push(ch);
		} else if (run.length > 0) {
			runs.push(run.join(""));
			run = [];
		}
	}
	if (run.length > 0) runs.push(run.join(""));
	return runs;
}

export function harnessQueryTerms(query: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const run of harnessQueryRuns(query.toLowerCase())) {
		let candidates: string[];
		if (CJK_TERM_CHAR_RE.test(run)) {
			const chars = [...run];
			if (chars.length > 1) {
				candidates = [];
				for (let i = 0; i < chars.length - 1; i += 1) {
					candidates.push(`${chars[i]}${chars[i + 1]}`);
				}
			} else {
				candidates = [run];
			}
		} else if (isAscii(run)) {
			candidates = run.length >= 3 ? [run] : [];
		} else {
			candidates = [...run].length >= 2 ? [run] : [];
		}
		for (const term of candidates) {
			if (!seen.has(term)) {
				seen.add(term);
				terms.push(term);
			}
		}
	}
	return terms;
}

export function rankHarnessIndices(
	query: string,
	titles: string[],
	contents: string[],
	pathAndIds: string[],
	updatedAts: string[],
	limit: number,
): number[] {
	const terms = harnessQueryTerms(query);
	const termCount = terms.length;
	const count = titles.length;
	if (termCount === 0 || count === 0) return [];

	const df = new Int32Array(termCount);
	const hitEntries: number[] = [];
	const hitTerms: number[] = [];
	const hitFields: number[] = [];

	for (let i = 0; i < count; i += 1) {
		const title = titles[i]!.toLowerCase();
		const content = contents[i]!.toLowerCase();
		const pathAndId = pathAndIds[i]!.toLowerCase();
		for (let t = 0; t < termCount; t += 1) {
			const term = terms[t]!;
			const fields =
				(title.includes(term) ? 1 : 0) +
				(content.includes(term) ? 1 : 0) +
				(pathAndId.includes(term) ? 1 : 0);
			if (fields > 0) {
				df[t] += 1;
				hitEntries.push(i);
				hitTerms.push(t);
				hitFields.push(fields);
			}
		}
	}

	if (hitEntries.length === 0) return [];

	const idf = new Float64Array(termCount);
	for (let t = 0; t < termCount; t += 1) {
		const docFreq = df[t]!;
		if (docFreq > 0) {
			idf[t] = Math.log(1 + count / docFreq);
		}
	}

	const scored: Array<{ index: number; score: number; recency: string }> = [];
	let pos = 0;
	const totalHits = hitEntries.length;
	while (pos < totalHits) {
		const entryIndex = hitEntries[pos]!;
		let total = 0;
		while (pos < totalHits && hitEntries[pos] === entryIndex) {
			const termIdf = idf[hitTerms[pos]!]!;
			const fields = hitFields[pos]!;
			total += termIdf * (1 + (fields - 1) * 0.5);
			pos += 1;
		}
		if (total > 0) {
			scored.push({ index: entryIndex, score: total, recency: updatedAts[entryIndex] || "" });
		}
	}

	scored.sort((a, b) => b.score - a.score || b.recency.localeCompare(a.recency));
	return scored.slice(0, limit).map((item) => item.index);
}
