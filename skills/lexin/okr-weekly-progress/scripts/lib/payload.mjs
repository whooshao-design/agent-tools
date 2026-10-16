// 保存草稿接口 edit_kr_process.json（option=1）一次覆盖一个 O 下全部 KR 的草稿。
// 这里只做纯计算：把服务端详情归一化、合成整组请求、写后逐字段核验。

const str = (v) => (v === undefined || v === null ? '' : String(v));

// 判空严格照搬页面：process_with_rich_text!=="" || progress_ratio!=="0" || process_status（原始值、严格比较），
// 否则页面认为非空的草稿在这里被当成空草稿、改用已发布进展的进度和状态
function draftOf(raw) {
  if (!raw) return null;
  const nonEmpty = raw.process_with_rich_text !== '' || raw.progress_ratio !== '0' || Boolean(raw.process_status);
  return nonEmpty ? { html: str(raw.process_with_rich_text), ratio: str(raw.progress_ratio ?? '0'), status: Number(raw.process_status || 0), modifyTime: str(raw.draft_modify_time) } : null;
}

export function normalizeDetail(objId, detailJson) {
  const row = Array.isArray(detailJson?.result_rows) ? detailJson.result_rows[0] : detailJson?.result_rows;
  if (!row) throw new Error(`get_obj_detail 没有返回 obj ${objId}`);
  return {
    objId: Number(objId),
    krs: (row.kr_process_list || []).map((p) => {
      const latest = p.latest_kr_process;
      return {
        krId: Number(p.kr_id),
        draft: draftOf(p.process_draft_content),
        draftModifyTime: str(p.process_draft_content?.draft_modify_time),
        latest: latest ? { html: str(latest.process_with_rich_text), ratio: str(latest.progress_ratio || '0'), status: Number(latest.process_status || 0), publishTime: str(latest.publish_time) } : null,
      };
    }),
  };
}

// 乐空间 publish_time 形如 "2026/10/16 13:53:01"（北京时间）
export function parseLecoTime(text) {
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`) : null;
}

// additions: Map<krId, html>。返回整组请求与逐 KR 计划；没有任何 KR 需要追加时 request 为 null
export function buildRequest(obj, additions, { windowStart, includePublished = false } = {}) {
  const plan = [];
  const krProcessList = obj.krs.map((kr) => {
    const keep = kr.draft
      ? { content: kr.draft.html, ratio: kr.draft.ratio, status: kr.draft.status }
      : { content: '', ratio: '0', status: 0 };
    const add = additions.get(kr.krId);
    let action = kr.draft ? 'keep' : 'keep-empty';
    let next = keep;
    if (add !== undefined) {
      const published = kr.latest && windowStart && parseLecoTime(kr.latest.publishTime) >= windowStart;
      if (published && !includePublished) action = 'skip-published';
      else if (kr.draft && kr.draft.html.includes(add)) action = 'skip-duplicate';
      else {
        action = 'append';
        const base = kr.draft ? kr.draft.html : '';
        const from = kr.draft || kr.latest || { ratio: '0', status: 0 };
        next = { content: base + add, ratio: str(from.ratio || '0'), status: Number(from.status || 0) };
      }
    }
    plan.push({ krId: kr.krId, action, beforeChars: keep.content.length, afterChars: next.content.length, expected: next, base: keep.content, addition: action === 'append' ? add : '' });
    return { krId: kr.krId, progressRatio: next.ratio, processStatus: next.status, processContent: next.content };
  });
  const request = plan.some((p) => p.action === 'append') ? { objId: obj.objId, option: 1, krProcessList } : null;
  return { request, plan };
}

// 提交前：任一 KR 草稿修改时间变化说明评审期间有人（多半是打开着的「添加进展」页面）改过
export function changedSince(before, now) {
  const at = new Map(now.krs.map((k) => [k.krId, k.draftModifyTime]));
  return before.krs.filter((k) => at.get(k.krId) !== k.draftModifyTime).map((k) => k.krId);
}

// 写后核验：目标 KR = 旧草稿 + 新增，其他 KR 与计划逐字段相等，已发布进展不变
export function verifyAfterWrite(before, after, plan) {
  const problems = [];
  const afterById = new Map(after.krs.map((k) => [k.krId, k]));
  for (const p of plan) {
    const now = afterById.get(p.krId);
    const prev = before.krs.find((k) => k.krId === p.krId);
    if (!now) { problems.push({ krId: p.krId, field: 'kr', detail: '写后找不到该 KR' }); continue }
    const got = now.draft ? { content: now.draft.html, ratio: now.draft.ratio, status: now.draft.status } : { content: '', ratio: '0', status: 0 };
    if (p.action === 'append') {
      if (!got.content.startsWith(p.base)) problems.push({ krId: p.krId, field: 'content', detail: '原草稿没有完整保留在开头' });
      if (!got.content.includes(p.addition)) problems.push({ krId: p.krId, field: 'content', detail: '新增内容未写入' });
    } else if (p.action === 'keep-empty' && now.draft) {
      // 按页面规则这条草稿已不再是空的：用户打开「添加进展」时不会再回填上次已发布的进展
      problems.push({ krId: p.krId, field: 'draft', detail: '原本为空的草稿在页面看来已非空，将不再回填已发布进展' });
    } else if (got.content !== p.expected.content) {
      problems.push({ krId: p.krId, field: 'content', detail: `非目标 KR 草稿被改动（${p.expected.content.length} → ${got.content.length} 字符）` });
    }
    if (got.ratio !== p.expected.ratio) problems.push({ krId: p.krId, field: 'progressRatio', detail: `${p.expected.ratio} → ${got.ratio}` });
    if (got.status !== p.expected.status) problems.push({ krId: p.krId, field: 'processStatus', detail: `${p.expected.status} → ${got.status}` });
    if (str(prev?.latest?.publishTime) !== str(now.latest?.publishTime)) problems.push({ krId: p.krId, field: 'publishTime', detail: '已发布进展发生变化' });
  }
  return problems;
}

// 恢复用：把快照原样合成整组请求（空草稿保持为空）
export function restoreRequest(snapshot) {
  return {
    objId: snapshot.objId,
    option: 1,
    krProcessList: snapshot.krs.map((k) => (k.draft
      ? { krId: k.krId, progressRatio: k.draft.ratio, processStatus: k.draft.status, processContent: k.draft.html }
      : { krId: k.krId, progressRatio: '0', processStatus: 0, processContent: '' })),
  };
}
