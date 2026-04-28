import DOMPurify from 'dompurify';

// DOMPurify 默认严格策略 + 允许 <custom-style>(在 encodeStyleTags 阶段把 <style> 临时转成它,
// sanitize 后由 decodeStyleTags 还原并加 scope)
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['custom-style'],
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    RETURN_TRUSTED_TYPE: false,
  }) as unknown as string;
}
