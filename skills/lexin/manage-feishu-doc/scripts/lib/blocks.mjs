// docx 块的通用读取：分页拉全部块、读某个父块的直接子块、取块内文本。
export const TEXT_CONTAINER_KEYS = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "heading7",
  "heading8",
  "heading9",
  "bullet",
  "ordered",
  "code",
  "quote",
  "todo",
  "callout",
];

export function elementsText(elements = []) {
  return elements.map((element) => element?.text_run?.content ?? "").join("");
}

export function blockText(block) {
  for (const key of TEXT_CONTAINER_KEYS) {
    if (block?.[key]?.elements) return elementsText(block[key].elements);
  }
  return "";
}

export function responseItems(value) {
  return value?.items ?? value?.data?.items ?? [];
}

export function responsePage(value) {
  return {
    hasMore: Boolean(value?.has_more ?? value?.data?.has_more),
    pageToken: value?.page_token ?? value?.data?.page_token ?? null,
  };
}

async function pageThrough(fetchPage) {
  const items = [];
  let pageToken = null;
  do {
    const value = await fetchPage(pageToken);
    items.push(...responseItems(value));
    const page = responsePage(value);
    pageToken = page.hasMore ? page.pageToken : null;
    if (page.hasMore && !pageToken) {
      const error = new Error("飞书分页响应缺少 page_token");
      error.code = "INVALID_LARK_RESPONSE";
      throw error;
    }
  } while (pageToken);
  return items;
}

// One paged sweep returns every block in the document, table cells and their
// text children included. Walking the tree with documentBlockChildren.get costs
// one call per cell instead, which is orders of magnitude slower on big tables.
export async function listAllBlocks(transport, documentToken) {
  return pageThrough((pageToken) =>
    transport.call("docx.v1.documentBlock.list", {
      path: { document_id: documentToken },
      params: { page_size: 500, document_revision_id: -1, ...(pageToken ? { page_token: pageToken } : {}) },
    }),
  );
}

export async function listChildren(transport, documentToken, blockId) {
  return pageThrough((pageToken) =>
    transport.call("docx.v1.documentBlockChildren.get", {
      path: { document_id: documentToken, block_id: blockId },
      params: { page_size: 500, document_revision_id: -1, ...(pageToken ? { page_token: pageToken } : {}) },
    }),
  );
}
