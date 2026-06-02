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

INSERT OR IGNORE INTO site_settings (key, value) VALUES
  ('artist_page_path', '/artist.html'),
  ('artist_directory_path', '/artists.html');

INSERT OR IGNORE INTO artist_profiles (slug, display_name, location, medium, joined_label, short_quote, bio, testimony_summary, public_video_url, embed_video_url, hero_image_url, artwork_json, status) VALUES
  ('artist-one', 'Artist One', 'City, State', 'Medium', 'Joined 2025', 'Placeholder quote for Artist One.', 'Placeholder bio for Artist One. Update this in the admin dashboard.', 'Placeholder testimony summary for Artist One.', '', '', '', '[]', 'active'),
  ('artist-two', 'Artist Two', 'City, State', 'Medium', 'Joined 2025', 'Placeholder quote for Artist Two.', 'Placeholder bio for Artist Two. Update this in the admin dashboard.', 'Placeholder testimony summary for Artist Two.', '', '', '', '[]', 'active');