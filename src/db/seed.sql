INSERT OR IGNORE INTO site_settings (key, value) VALUES
  ('site_base_url', 'https://www.jesusismykingmovement.com'),
  ('founder_display_name', 'Founder, Jesus Is My King Movement'),
  ('founder_public_video_url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
  ('founder_embed_video_url', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('founder_short_quote', 'Every testimony starts with what Jesus has already done.'),
  ('founder_testimony_summary', 'This founder testimony appears whenever a testimony QR code has not been claimed yet. Once an owner submits and is approved, that same printed clothing-item QR code can resolve to the owner''s video instead.');

INSERT OR IGNORE INTO testimony_item_codes (item_code, destination_mode) VALUES
  ('JIMK-SHARE-001', 'default_founder'),
  ('JIMK-SHARE-002', 'default_founder'),
  ('JIMK-SHARE-003', 'default_founder');