// ══════════════════════════════════════════════════════════════
//  채보 생성 로직 — index.html의 것과 반드시 동일해야 한다.
//
//  ⚠️ index.html의 TRACKS / DIFF_PARAMS / generateChart / makeRng /
//     hashSeed / STAGE_DURATION / CHART_LEAD_IN 을 수정하면
//     이 파일도 같이 고쳐야 한다. 어긋나면 정상 점수가 반려된다.
//
//  서버는 노트 "개수"만 필요하지만, 난수 소비 순서가 1비트라도
//  달라지면 개수가 달라지므로 생성 로직을 그대로 옮겨 둔다.
// ══════════════════════════════════════════════════════════════

export const STAGE_DURATION = 90;
export const CHART_LEAD_IN = 2.0;

export interface DiffParam {
    subDivision: number;
    fillProb: number;
    chord4: number;
    chord6: number;
}

export const DIFF_PARAMS: Record<string, DiffParam> = {
    EASY:   { subDivision: 1, fillProb: 0.00, chord4: 0.00, chord6: 0.00 },
    NORMAL: { subDivision: 2, fillProb: 0.50, chord4: 0.05, chord6: 0.15 },
    HARD:   { subDivision: 4, fillProb: 0.45, chord4: 0.30, chord6: 0.40 },
    EXPERT: { subDivision: 4, fillProb: 0.75, chord4: 0.45, chord6: 0.55 },
};

export const LANE_COUNTS: Record<number, number> = { 4: 4, 6: 6 };

export interface TrackDef {
    bpm: number;
    difficulties: string[];
}

// 곡 카탈로그 — index.html의 TRACKS와 id / bpm / 난이도 목록이 일치해야 한다
export const TRACKS: Record<string, TrackDef> = {
    neon_city_night:  { bpm: 110, difficulties: ['EASY', 'NORMAL'] },
    cybernetic_pulse: { bpm: 135, difficulties: ['EASY', 'NORMAL', 'HARD'] },
    midnight_rush:    { bpm: 174, difficulties: ['NORMAL', 'HARD', 'EXPERT'] },
    overdrive_heart:  { bpm: 190, difficulties: ['HARD', 'EXPERT'] },
};

// 문자열 -> 32bit 시드 (FNV-1a)
function hashSeed(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// mulberry32
function makeRng(seed: number): () => number {
    let t = seed >>> 0;
    return function () {
        t = (t + 0x6D2B79F5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/** 해당 (곡 · 난이도 · 키모드) 채보의 노트 개수를 계산한다. */
export function countNotes(
    songId: string,
    diffName: string,
    keyMode: number,
    durationSec: number = STAGE_DURATION,
): number {
    const track = TRACKS[songId];
    const params = DIFF_PARAMS[diffName];
    const laneCount = LANE_COUNTS[keyMode];
    if (!track || !params || !laneCount) return 0;

    const chordChance = keyMode === 6 ? params.chord6 : params.chord4;
    const rng = makeRng(hashSeed(songId + '|' + diffName + '|' + keyMode + 'K'));

    const beatInterval = 60 / track.bpm;
    const stepTime = beatInterval / params.subDivision;
    const totalSteps = Math.floor((durationSec - CHART_LEAD_IN) / stepTime);

    let count = 0;
    let lastLane = -1;

    for (let i = 0; i < totalSteps; i++) {
        const isMainBeat = i % params.subDivision === 0;

        if (!isMainBeat && rng() >= params.fillProb) continue;

        let lane = Math.floor(rng() * laneCount);
        while (lane === lastLane && rng() > 0.2) {
            lane = Math.floor(rng() * laneCount);
        }
        lastLane = lane;
        count++;

        if (chordChance > 0 && isMainBeat && rng() < chordChance) {
            // 개수만 세면 되지만, 클라이언트는 여기서 secondLane 계산에 난수를
            // 한 번 더 쓴다. 소비하지 않으면 이후 난수열이 통째로 어긋난다.
            rng();
            count++;
        }
    }

    return count;
}

/**
 * 이론상 최대 점수.
 *
 * 클라이언트 배점: PERFECT = 1000 + (직전 콤보 × 10), 매 노트마다 콤보 +1.
 * 전부 PERFECT일 때가 최대이므로
 *   Σ(i=0..n-1) (1000 + 10i) = 1000n + 5n(n-1)
 */
export function maxScoreForNotes(noteCount: number): number {
    return 1000 * noteCount + 5 * noteCount * (noteCount - 1);
}

/**
 * 최대 콤보가 M으로 제한됐을 때의 상한.
 *
 * 콤보 보너스는 노트당 최대 10 × (M-1)이므로 n × (1000 + 10(M-1)).
 * 위 전체 상한과 함께 min을 취하면, "콤보는 낮은데 점수만 높은" 조작을 걸러낸다.
 */
export function maxScoreForCombo(noteCount: number, maxCombo: number): number {
    return noteCount * (1000 + 10 * Math.max(0, maxCombo - 1));
}
