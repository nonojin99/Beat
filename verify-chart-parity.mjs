/**
 * 채보 로직 정합성 검사
 *
 *   node tools/verify-chart-parity.mjs
 *
 * index.html(클라이언트)과 supabase/functions/submit-score/chart.ts(서버)의
 * 채보 생성 결과가 모든 (곡 × 난이도 × 키모드) 조합에서 같은지 확인한다.
 *
 * 서버는 이 노트 수로 점수 상한을 계산하므로, 둘이 어긋나면 정상 점수가
 * 반려되거나 조작 점수가 통과한다. 채보 관련 상수·로직을 건드렸다면
 * 반드시 이 스크립트를 돌릴 것.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    TRACKS as SERVER_TRACKS,
    countNotes,
} from '../supabase/functions/submit-score/chart.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** index.html의 <script> 본문에서 이름 붙은 선언 하나를 통째로 잘라낸다. */
function extractDeclaration(source, header) {
    const start = source.indexOf(header);
    if (start < 0) {
        throw new Error(`index.html에서 "${header}" 를 찾지 못했습니다.`);
    }

    let i = start;
    let depth = 0;
    let opened = false;

    // 괄호()는 세지 않는다. 함수의 매개변수 목록에서 잘려버린다.
    while (i < source.length) {
        const ch = source[i];

        if (ch === '{' || ch === '[') {
            depth++;
            opened = true;
        } else if (ch === '}' || ch === ']') {
            depth--;
            if (opened && depth === 0) return source.slice(start, i + 1);
        } else if (ch === ';' && depth === 0 && !opened) {
            // 블록이 없는 단순 대입 (예: var STAGE_DURATION = 90;)
            return source.slice(start, i + 1);
        }
        i++;
    }

    throw new Error(`"${header}" 선언의 끝을 찾지 못했습니다.`);
}

function loadClientChart() {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const body = html.split('<script>').pop().split('</script>')[0];

    const parts = [
        'var STAGE_DURATION =',
        'var CHART_LEAD_IN =',
        'var TRACKS =',
        'var DIFF_PARAMS =',
        'var KEY_MODES =',
        'function hashSeed(',
        'function makeRng(',
        'function generateChart(',
    ].map((header) => extractDeclaration(body, header));

    const code = parts.join('\n') +
        '\nreturn { STAGE_DURATION, TRACKS, DIFF_PARAMS, generateChart };';

    return new Function(code)();
}

const client = loadClientChart();

const failures = [];
const rows = [];

// 1. 곡 카탈로그(id / bpm / 난이도 목록)가 서버와 같은지
for (const track of client.TRACKS) {
    const server = SERVER_TRACKS[track.id];
    if (!server) {
        failures.push(`서버 카탈로그에 "${track.id}" 가 없습니다`);
        continue;
    }
    if (server.bpm !== track.bpm) {
        failures.push(`bpm 불일치 ${track.id}: 클라 ${track.bpm} / 서버 ${server.bpm}`);
    }
    const clientDiffs = track.difficulties.map((d) => d.name).sort().join(',');
    const serverDiffs = [...server.difficulties].sort().join(',');
    if (clientDiffs !== serverDiffs) {
        failures.push(`난이도 목록 불일치 ${track.id}: 클라 [${clientDiffs}] / 서버 [${serverDiffs}]`);
    }
}

for (const id of Object.keys(SERVER_TRACKS)) {
    if (!client.TRACKS.some((t) => t.id === id)) {
        failures.push(`클라이언트에 없는 곡이 서버 카탈로그에 있습니다: "${id}"`);
    }
}

// 2. 모든 조합의 노트 수 비교
for (const keyMode of [4, 6]) {
    for (const track of client.TRACKS) {
        for (const diff of track.difficulties) {
            const expected = client.generateChart(track, diff, keyMode, client.STAGE_DURATION).length;
            const actual = countNotes(track.id, diff.name, keyMode, client.STAGE_DURATION);
            const ok = expected === actual;

            if (!ok) {
                failures.push(
                    `노트 수 불일치 ${keyMode}K ${track.id} ${diff.name}: 클라 ${expected} / 서버 ${actual}`,
                );
            }

            rows.push(
                `${ok ? '  ok' : 'FAIL'}  ${keyMode}K  ${track.id.padEnd(17)} ${diff.name.padEnd(7)}` +
                ` ${String(expected).padStart(4)} notes`,
            );
        }
    }
}

console.log(rows.join('\n'));

if (failures.length) {
    console.error('\n✗ 정합성 검사 실패\n');
    for (const f of failures) console.error('  - ' + f);
    console.error('\nindex.html 과 chart.ts 의 채보 로직을 다시 맞추세요.');
    process.exit(1);
}

console.log(`\n✓ ${rows.length}개 조합 전부 일치 (카탈로그 포함)`);
