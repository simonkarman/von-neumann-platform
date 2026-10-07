#!/bin/bash
set -euo pipefail
# DOCKER-USER covers forwarded access to IMDS; INPUT blocks access to host
# services through the internal bridge (including host metadata proxies).
iptables -C DOCKER-USER -s 172.29.0.0/24 -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -I DOCKER-USER 1 -s 172.29.0.0/24 -d 169.254.169.254/32 -j REJECT
iptables -C INPUT -s 172.29.0.0/24 -m conntrack --ctstate NEW -j REJECT 2>/dev/null || iptables -I INPUT 1 -s 172.29.0.0/24 -m conntrack --ctstate NEW -j REJECT
