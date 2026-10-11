"""Personal egress credentials API for non-admin users, assembled from one module per route group.

- `egress_listing`: every agent the user may use with its services, and the preset catalog.
- `egress_logs`: the caller's own recent brokered requests.
- `egress_keys`: set or delete a service's key.
- `egress_user_services`: read, save, and delete the services a scope defines for itself.
- `egress_accounts`: connect or disconnect a service's OAuth account.
- `egress_access`: the request gates and agent resolution they share.
"""

from __future__ import annotations

from fastapi import APIRouter

from mindroom.api import egress_accounts, egress_keys, egress_listing, egress_logs, egress_user_services

_PREFIX = "/api/connections/egress"

router = APIRouter()
router.include_router(egress_listing.router, prefix=_PREFIX, tags=["egress-credentials"])
router.include_router(egress_logs.router, prefix=_PREFIX, tags=["egress-credentials"])
router.include_router(egress_keys.router, prefix=_PREFIX, tags=["egress-credentials"])
router.include_router(egress_user_services.router, prefix=_PREFIX, tags=["egress-credentials"])
router.include_router(egress_accounts.router, prefix=_PREFIX, tags=["egress-credentials"])
