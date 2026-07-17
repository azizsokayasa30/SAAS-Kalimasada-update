-- L2TP/IPsec support for platform management VPN

ALTER TABLE platform_vpn_server ADD COLUMN ipsec_psk TEXT;
ALTER TABLE platform_vpn_server ADD COLUMN l2tp_enabled INTEGER DEFAULT 1;

ALTER TABLE platform_vpn_peers ADD COLUMN protocol TEXT DEFAULT 'wireguard';
ALTER TABLE platform_vpn_peers ADD COLUMN routeros_version TEXT;
ALTER TABLE platform_vpn_peers ADD COLUMN l2tp_username TEXT;
ALTER TABLE platform_vpn_peers ADD COLUMN l2tp_password TEXT;

CREATE INDEX IF NOT EXISTS idx_platform_vpn_peers_protocol ON platform_vpn_peers(protocol);
