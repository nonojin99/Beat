// ══════════════════════════════════════════════════════════════
//  submit-score — 리더보드 점수 등록 Edge Function
//
//  클라이언트에서 leaderboard 테이블에 직접 INSERT 하는 것을 막고,
//  이 함수만 서버 권한(service role)으로 기록하게 한다.
//
//  검증 항목
//   1. 입력 형식 (곡 / 난이도 / 키모드 / 닉네임 / 숫자 범위)
//   2. 해당 곡에 실제로 존재하는 난이도인지
//   3. max_combo ≤ 그 채보의 노트 수
//   4. score ≤ 그 채보의 이론상 최대 점수 (콤보 상한까지 반영)
//   5. 제출 빈도 제한 (연타 / 스크립트 도배 차단)
//
//  배포:  supabase functions deploy submit-score --no-verify-jwt
// ══════════════════════════════════════════════════════════════

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
    TRACKS,
    countNotes,
    maxScoreForNotes,
    maxScoreForCombo,
} from './chart.ts';

const VALID_KEY_MODES = [4, 6];
const NICKNAME_MAX = 12;

// 한 스테이지는 최소 90초이므로, 같은 닉네임이 이보다 자주 제출하면 비정상
const MIN_SUBMIT_GAP_SEC = 60;
const MAX_SUBMITS_PER_HOUR = 60;

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}

function isInt(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v);
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'POST') {
        return reply(405, { error: 'POST만 허용됩니다' });
    }

    let payload: Record<string, unknown>;
    try {
        payload = await req.json();
    } catch {
        return reply(400, { error: '잘못된 JSON 형식입니다' });
    }

    const userName = String(payload.user_name ?? '').trim();
    const songId = String(payload.song_id ?? '');
    const difficulty = String(payload.difficulty ?? '').toUpperCase();
    const keyMode = payload.key_mode;
    const score = payload.score;
    const maxCombo = payload.max_combo;

    // ── 1. 형식 검증 ────────────────────────────────────────
    if (!userName || userName.length > NICKNAME_MAX) {
        return reply(400, { error: `닉네임은 1~${NICKNAME_MAX}자여야 합니다` });
    }
    // 제어문자 차단 (표시용 이스케이프는 클라이언트에서 별도 처리)
    if (/[\u0000-\u001f\u007f]/.test(userName)) {
        return reply(400, { error: '닉네임에 사용할 수 없는 문자가 있습니다' });
    }
    if (!isInt(keyMode) || !VALID_KEY_MODES.includes(keyMode)) {
        return reply(400, { error: 'key_mode는 4 또는 6이어야 합니다' });
    }
    if (!isInt(score) || score < 0) {
        return reply(400, { error: 'score가 올바르지 않습니다' });
    }
    if (!isInt(maxCombo) || maxCombo < 0) {
        return reply(400, { error: 'max_combo가 올바르지 않습니다' });
    }

    // ── 2. 곡 / 난이도 존재 여부 ────────────────────────────
    const track = TRACKS[songId];
    if (!track) {
        return reply(400, { error: '존재하지 않는 곡입니다' });
    }
    if (!track.difficulties.includes(difficulty)) {
        return reply(400, { error: '이 곡에 없는 난이도입니다' });
    }

    // ── 3 & 4. 채보를 서버에서 재생성해 상한 검증 ───────────
    // 채보가 시드 고정이라 서버가 정확한 노트 수를 알 수 있다.
    const noteCount = countNotes(songId, difficulty, keyMode);
    if (noteCount <= 0) {
        return reply(500, { error: '채보 계산에 실패했습니다' });
    }

    if (maxCombo > noteCount) {
        return reply(422, {
            error: `콤보가 노트 수를 초과했습니다 (${maxCombo} > ${noteCount})`,
        });
    }

    const ceiling = Math.min(
        maxScoreForNotes(noteCount),
        maxScoreForCombo(noteCount, maxCombo),
    );
    if (score > ceiling) {
        return reply(422, {
            error: `이 채보에서 나올 수 없는 점수입니다 (최대 ${ceiling})`,
        });
    }

    // ── 5. DB 기록 ──────────────────────────────────────────
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey =
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
        Deno.env.get('SUPABASE_SECRET_KEY');

    if (!supabaseUrl || !serviceKey) {
        console.error('service role 키를 찾을 수 없습니다');
        return reply(500, { error: '서버 설정 오류' });
    }

    const admin = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false },
    });

    // 제출 빈도 제한
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { data: recent, error: recentErr } = await admin
        .from('leaderboard')
        .select('created_at')
        .eq('user_name', userName)
        .gte('created_at', hourAgo)
        .order('created_at', { ascending: false });

    if (recentErr) {
        console.error('빈도 확인 실패:', recentErr.message);
    } else if (recent && recent.length > 0) {
        if (recent.length >= MAX_SUBMITS_PER_HOUR) {
            return reply(429, { error: '시간당 제출 횟수를 초과했습니다' });
        }
        const gap = (Date.now() - new Date(recent[0].created_at).getTime()) / 1000;
        if (gap < MIN_SUBMIT_GAP_SEC) {
            return reply(429, {
                error: `너무 빠른 제출입니다 (${Math.ceil(MIN_SUBMIT_GAP_SEC - gap)}초 후 다시 시도)`,
            });
        }
    }

    const { error: insertErr } = await admin.from('leaderboard').insert([{
        user_name: userName,
        song_id: songId,
        key_mode: keyMode,
        difficulty: difficulty,
        score: score,
        max_combo: maxCombo,
    }]);

    if (insertErr) {
        console.error('INSERT 실패:', insertErr.message);
        return reply(500, { error: '점수 저장에 실패했습니다' });
    }

    return reply(200, { ok: true, note_count: noteCount, ceiling });
});
