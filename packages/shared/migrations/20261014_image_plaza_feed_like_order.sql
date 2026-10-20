-- domain: experience
-- 广场 feed 改为 like_count DESC, published_at DESC, id DESC；替换原仅按发布时间的索引。

DROP INDEX IF EXISTS experience.image_plaza_works_feed_idx;

CREATE INDEX image_plaza_works_feed_idx
  ON experience.image_plaza_works (like_count DESC, published_at DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX experience.image_plaza_works_feed_idx IS
  '图片广场 feed：点赞数优先，其次分享时间；仅未软删作品。';
