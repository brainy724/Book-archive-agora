// Vercel Edge Function - AGORA Claude API Proxy
//
// 배포 방법:
//   1. 이 파일을 프로젝트 루트/api/messages.js 로 저장
//   2. Vercel에 배포
//   3. 환경변수 설정:
//      - CLAUDE_API_KEY
//      - ALLOWED_ORIGINS
//      - SUPABASE_URL
//      - SUPABASE_ANON_KEY
//
// 엔드포인트:
//   - GET  /api/health  → 상태 체크
//   - POST /api/messages → Claude 호출

export const config = {
  runtime: 'edge',
  regions: ['iad1'], // US East (Washington DC) - Anthropic 차단 가능성 낮음
};

// 기본 허용 도메인
const DEFAULT_ALLOWED_ORIGINS = [
  'https://agora-archive.com',
  'https://www.agora-archive.com',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

export default async function handler(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';

  // CORS 검증
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : DEFAULT_ALLOWED_ORIGINS;
  const isAllowed = allowedOrigins.includes(origin) || allowedOrigins.includes('*');

  const corsHeaders = {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-User-Token',
    'Access-Control-Max-Age': '86400',
  };

  // OPTIONS (프리플라이트)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 라우팅
  try {
    // Vercel은 파일 경로 기반 라우팅: /api/messages, /api/health
    if (url.pathname === '/api/messages' && request.method === 'POST') {
      return await handleClaudeProxy(request, corsHeaders);
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ status: 'ok', timestamp: Date.now(), region: 'iad1' }, 200, corsHeaders);
    }

    return json({ error: 'Not Found', path: url.pathname }, 404, corsHeaders);
  } catch (err) {
    console.error('Handler error:', err);
    return json({ error: 'Internal error', message: err.message }, 500, corsHeaders);
  }
}

// ═══════════════════════════════════════════
// Claude API 프록시
// ═══════════════════════════════════════════

async function handleClaudeProxy(request, corsHeaders) {
  console.log('=== handleClaudeProxy 시작 ===');

  // 1. API 키 확인
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.log('❌ API 키 없음');
    return json({ error: 'Server misconfiguration', message: 'API key not set' }, 500, corsHeaders);
  }
  console.log('✅ API 키 있음');

  // 2. 유저 인증
  const userId = request.headers.get('X-User-Id');
  const userToken = request.headers.get('X-User-Token');

  console.log('유저 ID:', userId, '토큰:', userToken ? '있음' : '없음');

  if (!userId || !userToken) {
    console.log('❌ 유저 정보 누락');
    return json({ error: 'Unauthorized', message: 'User credentials missing' }, 401, corsHeaders);
  }

  // 3. Supabase 프리미엄 검증
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    console.log('✅ Supabase 환경변수 있음, 검증 시작');
    const isValid = await verifyPremiumUser(userId);
    console.log('verifyPremiumUser 결과:', isValid);
    if (!isValid) {
      return json({ error: 'Forbidden', message: 'Premium membership required' }, 403, corsHeaders);
    }
  } else {
    console.log('⚠️ Supabase 환경변수 없음, 검증 스킵');
  }

  // 4. 월별 사용량 체크
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    const usage = await checkUsageLimit(userId);
    console.log('checkUsageLimit 결과:', JSON.stringify(usage));
    if (usage.blocked) {
      return json({
        error: 'Rate limit exceeded',
        message: `이번 달 한도(${usage.limit}회) 도달`,
        used: usage.used,
        limit: usage.limit
      }, 429, corsHeaders);
    }
  }

  // 5. 요청 본문 읽기
  let body;
  try {
    body = await request.json();
  } catch {
    console.log('❌ Invalid JSON');
    return json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  // 악용 방지
  const safeBody = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: Math.min(body.max_tokens || 1024, 2048),
    system: body.system,
    messages: body.messages,
  };

  console.log('🚀 Anthropic API 호출 시작, 모델:', safeBody.model);

  // 6. Anthropic API 호출
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(safeBody),
  });

  console.log('📥 Anthropic 응답 status:', anthropicRes.status);

  const responseBody = await anthropicRes.text();

  if (!anthropicRes.ok) {
    console.log('❌ Anthropic 에러 응답 내용:', responseBody.substring(0, 500));
  } else {
    console.log('✅ Anthropic 정상 응답');
  }

  return new Response(responseBody, {
    status: anthropicRes.status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

// ═══════════════════════════════════════════
// Supabase 검증
// ═══════════════════════════════════════════

async function verifyPremiumUser(userId) {
  try {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/agora_users?id=eq.${encodeURIComponent(userId)}&select=id,username,premium_until,trial_started_at,banned,is_admin`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        }
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error('verifyPremiumUser: Supabase fetch failed', res.status, errText.slice(0, 200));
      return false;
    }

    const users = await res.json();
    if (!users.length) {
      console.warn('verifyPremiumUser: user not found, id=' + userId);
      return false;
    }

    const user = users[0];
    console.log('verifyPremiumUser: found user', user.username, 'admin:', user.is_admin, 'premium_until:', user.premium_until);

    if (user.banned) {
      console.warn('verifyPremiumUser: user banned, id=' + userId);
      return false;
    }

    // 관리자는 항상 통과
    if (user.is_admin === true) {
      console.log('verifyPremiumUser: admin bypass, id=' + userId);
      return true;
    }

    const now = new Date();
    if (user.premium_until && new Date(user.premium_until) > now) {
      console.log('verifyPremiumUser: premium active until', user.premium_until);
      return true;
    }

    if (user.trial_started_at) {
      const end = new Date(user.trial_started_at);
      end.setDate(end.getDate() + 30);
      if (now < end) {
        console.log('verifyPremiumUser: trial active, ends', end.toISOString());
        return true;
      }
    }

    console.warn('verifyPremiumUser: not premium. user=', user.username);
    return false;
  } catch (e) {
    console.error('verifyPremiumUser error:', e.message);
    return false;
  }
}

async function checkUsageLimit(userId) {
  try {
    const now = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    const usageRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/agora_ai_usage?user_id=eq.${encodeURIComponent(userId)}&year_month=eq.${monthKey}&select=count`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        }
      }
    );

    let used = 0;
    if (usageRes.ok) {
      const data = await usageRes.json();
      if (data.length) used = data[0].count || 0;
    }

    const limitRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/agora_settings?key=eq.ai_monthly_limit&select=value`,
      {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        }
      }
    );

    let limit = 50;
    if (limitRes.ok) {
      const data = await limitRes.json();
      if (data.length) limit = parseInt(data[0].value) || 50;
    }

    return { used, limit, blocked: used >= limit };
  } catch (e) {
    console.error('checkUsageLimit error:', e);
    return { used: 0, limit: 50, blocked: false };
  }
}

// ═══════════════════════════════════════════
// 헬퍼
// ═══════════════════════════════════════════

function json(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}
