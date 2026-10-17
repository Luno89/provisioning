#!/bin/sh
set -eu

: "${MAIL_DOMAIN:?MAIL_DOMAIN is the domain mail is sent from}"
HOST="${MAIL_HOSTNAME:-mail.${MAIL_DOMAIN}}"
SELECTOR="${DKIM_SELECTOR:-koala}"
PORT="${MAIL_PORT:-2525}"
LISTEN="${MAIL_LISTEN:-loopback-only}"
TRUSTED="${MAIL_TRUSTED:-127.0.0.0/8}"
KEYS=/var/lib/dkim

mkdir -p "$KEYS"
if [ ! -f "$KEYS/$SELECTOR.private" ]; then
  opendkim-genkey -b 2048 -d "$MAIL_DOMAIN" -s "$SELECTOR" -D "$KEYS"
fi
chown -R opendkim:opendkim "$KEYS"
chmod 600 "$KEYS/$SELECTOR.private"

mkdir -p /etc/opendkim /run/opendkim
chown opendkim:opendkim /run/opendkim
cat > /etc/opendkim/opendkim.conf <<CONF
Syslog no
Mode s
Domain ${MAIL_DOMAIN}
Selector ${SELECTOR}
KeyFile ${KEYS}/${SELECTOR}.private
Socket inet:8891@127.0.0.1
InternalHosts csl:$(echo "${TRUSTED}" | tr ' ' ',')
Canonicalization relaxed/simple
SignatureAlgorithm rsa-sha256
OversignHeaders From
UserID opendkim
PidFile /run/opendkim/opendkim.pid
CONF

postconf -e \
  "myhostname=${HOST}" \
  "mydomain=${MAIL_DOMAIN}" \
  "myorigin=${MAIL_DOMAIN}" \
  "mydestination=" \
  "local_transport=error:this host only sends" \
  "inet_interfaces=${LISTEN}" \
  "inet_protocols=ipv4" \
  "mynetworks=${TRUSTED}" \
  "smtpd_relay_restrictions=permit_mynetworks,reject" \
  "smtpd_recipient_restrictions=permit_mynetworks,reject" \
  "smtp_tls_security_level=may" \
  "smtpd_milters=inet:127.0.0.1:8891" \
  "non_smtpd_milters=inet:127.0.0.1:8891" \
  "milter_default_action=tempfail" \
  "maillog_file=/dev/stdout" \
  "relayhost=${MAIL_RELAYHOST:-}"
postconf -MX smtp/inet
postconf -M "${PORT}/inet=${PORT} inet n - n - - smtpd"

echo "DKIM record for ${SELECTOR}._domainkey.${MAIL_DOMAIN}:"
cat "$KEYS/$SELECTOR.txt"

opendkim -x /etc/opendkim/opendkim.conf
exec postfix start-fg
