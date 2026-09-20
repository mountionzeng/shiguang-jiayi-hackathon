/*
 * 服务端错误码映射。单独成文件，便于不依赖云开发 SDK 直接测试。
 *
 * 2026-09-20：删掉原先的兜底正则 /不可用|没找到|不存在/。
 * 它会把任何带这些字的内部错误误判成 STORY_NOT_FOUND，掩盖真实故障，排查会走偏。
 * 业务错误改为在抛出处显式带 code，未知错误一律归为 STORY_BOOK_ERROR。
 */
const EXPLICIT_CODES = [
  'STORY_PROTOCOL_REQUIRED','CONTENT_REJECTED','STORY_EXCERPT_MISMATCH','STORY_SHARE_SELECTION_INVALID','STORY_SHARE_LIMIT',
  'VERSION_CONFLICT','INVALID_INPUT','DUPLICATE_TITLE','STORY_COPY_MEDIA_PENDING','STORY_COPY_STORAGE_ERROR','STORY_COPY_BUSY',
  'STORY_COPY_LIMIT','STORY_RETURN_EMPTY','STORY_RETURN_LIMIT',
  'AUTH_REQUIRED','IDENTITY_UNLINKED','STORY_FORBIDDEN','STORY_ACCESS_DISABLED','STORY_ACCESS_NOT_READY','STORY_INVITE_LIMIT',
  'MEMBER_INVALID','MEMBER_CONFLICT','MEMBER_NOT_FOUND','MEMBER_DELETED','MEMBER_REQUIRES_PROFILE',
  'STORY_NOT_FOUND','MIGRATION_NOT_READY','CROSS_STORY_REFERENCE',
];

function errorCode(error) {
  if (EXPLICIT_CODES.includes(error?.code)) return error.code;
  const message = String(error?.message || error || '');
  if (/重新登录|记录空间|创建记录档案/.test(message)) return 'AUTH_REQUIRED';
  if (/迁移|故事库.*准备/.test(message)) return 'MIGRATION_NOT_READY';
  if (/已有更新|重新加载|请求编号冲突|已处理/.test(message)) return 'VERSION_CONFLICT';
  if (/同名故事/.test(message)) return 'DUPLICATE_TITLE';
  if (/其他故事|不能引用|跨/.test(message)) return 'CROSS_STORY_REFERENCE';
  if (/无效|不能为空|不支持|请选择/.test(message)) return 'INVALID_INPUT';
  return 'STORY_BOOK_ERROR';
}

module.exports = { errorCode, EXPLICIT_CODES };
