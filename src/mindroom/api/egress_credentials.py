"""Personal egress credentials API for non-admin users, assembled from one module per route group.

- `egress_listing`: every agent the user may use with its services, and the preset catalog.
- `egress_logs`: the caller's own recent brokered requests.
- `egress_keys`: set or delete a service's key.
- `egress_services`: read, save, and delete the services a scope defines for itself.
- `egress_accounts`: connect or disconnect a service's OAuth account.
- `egress_access`: the request gates and agent resolution they share.
"""

from __future__ import annotations

from fastapi import APIRouter

from mindroom.api import egress_accounts, egress_keys, egress_listing, egress_logs, egress_services

router = APIRouter()
for _routes in (egress_listing, egress_logs, egress_keys, egress_services, egress_accounts):
    router.include_router(_routes.router, prefix="/api/connections/egress", tags=["egress-credentials"])
