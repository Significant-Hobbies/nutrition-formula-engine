"""Bounded candidate discovery. Providers never resolve or accept an input line."""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from copy import deepcopy
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation

from .versioning import fingerprint

# Only explicitly identified, unit-compatible observations enter a profile.
FDC_NUTRIENTS = {1008: ('energy', 'kcal'), 1003: ('protein', 'g'),
                 1004: ('total_fat', 'g'), 1005: ('carbohydrate', 'g'),
                 1087: ('calcium', 'mg'), 1089: ('iron', 'mg'), 1093: ('sodium', 'mg')}


def utc_now():
    return datetime.now(UTC).isoformat().replace('+00:00', 'Z')


def parse_candidates(provider, payload, retrieved_at, limit=8):
    """Parse synthetic or provider JSON, retaining raw evidence and missing values."""
    if not isinstance(payload, dict):
        raise ValueError('Response must be an object')
    if provider == 'pubchem':
        if payload.get('Fault', {}).get('Code') == 'PUGREST.NotFound':
            return []
        rows = payload['PropertyTable']['Properties']
    elif provider == 'fdc':
        rows = payload['foods']
    else:
        raise ValueError('Unknown provider')
    if not isinstance(rows, list) or len(rows) > 100:
        raise ValueError('Invalid candidate list')
    candidates = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Invalid candidate')
        identifier = row.get('CID' if provider == 'pubchem' else 'fdcId')
        name = row.get('Title' if provider == 'pubchem' else 'description')
        if type(identifier) is not int or identifier <= 0 or not isinstance(name, str) or not name.strip():
            raise ValueError('Missing candidate identity')
        if identifier in seen:
            raise ValueError('Duplicate candidate identity')
        seen.add(identifier)
        reference = (f'https://pubchem.ncbi.nlm.nih.gov/compound/{identifier}' if provider == 'pubchem'
                     else f'https://fdc.nal.usda.gov/food-details/{identifier}/nutrients')
        source = {'kind': provider, 'reference': reference, 'provider_id': str(identifier),
                  'retrieved_at': retrieved_at, 'raw_evidence': deepcopy(row)}
        nutrients = {}
        if provider == 'fdc':
            observations = row.get('foodNutrients', [])
            if not isinstance(observations, list):
                raise ValueError('Invalid nutrient list')
            for observation in observations:
                if not isinstance(observation, dict):
                    raise ValueError('Invalid nutrient')
                mapped = FDC_NUTRIENTS.get(observation.get('nutrientId'))
                if not mapped or observation.get('value') is None:
                    continue
                nutrient, unit = mapped
                if str(observation.get('unitName', '')).lower() != unit.lower():
                    raise ValueError('Incompatible nutrient unit')
                try:
                    value = Decimal(str(observation['value']))
                except InvalidOperation as exc:
                    raise ValueError('Invalid nutrient value') from exc
                if not value.is_finite() or value < 0 or nutrient in nutrients:
                    raise ValueError('Invalid or duplicate nutrient value')
                nutrients[nutrient] = {'value': str(value), 'unit': unit, 'source': deepcopy(source)}
        material = {'name': name, 'aliases': [], 'basis': {'value': '100', 'unit': 'g'},
                    'nutrients': nutrients, 'unlisted_nutrients_are_zero': False,
                    'identity_status': 'candidate', 'source': source}
        candidate = {'candidate_id': f'{provider}:{identifier}', 'provider': provider,
                     'provider_id': str(identifier), 'material_id': f'{provider}_{identifier}',
                     'name': name, 'catalog': 'chemical' if provider == 'pubchem' else 'food',
                     'source': source, 'retrieved_at': retrieved_at, 'candidate_only': True,
                     'has_composition_profile': bool(nutrients), 'material': material}
        candidate['evidence_id'] = fingerprint(candidate)
        candidates.append(candidate)
    return candidates[:limit]


class ProviderSearch:
    """Injected async transport: one request, 5s timeout, 64-entry/5-minute cache.

    Refresh always contacts transport. Expired evidence is discarded, never used
    on failure. Failures are not cached; acceptance requires current evidence.
    """
    def __init__(self, transport, *, clock=utc_now, monotonic=None):
        import time
        self.transport = transport
        self.clock = clock
        self.monotonic = monotonic or time.monotonic
        self.cache = OrderedDict()

    async def search(self, provider, query, *, refresh=False, limit=8):
        if provider not in {'pubchem', 'fdc'} or not isinstance(query, str) or not 1 <= len(query.strip()) <= 160:
            raise ValueError('Provider and 1–160 character query required')
        if type(limit) is not int or not 1 <= limit <= 8:
            raise ValueError('Limit must be 1–8')
        query = ' '.join(query.split())
        key = (provider, query.casefold(), limit)
        now = self.monotonic()
        for cached_key in list(self.cache):
            if now - self.cache[cached_key][0] >= 300:
                del self.cache[cached_key]
        if not refresh and key in self.cache:
            result = deepcopy(self.cache[key][1]); result['cached'] = True
            return result
        self.cache.pop(key, None)
        result = {'provider': provider, 'query': query, 'candidates': [], 'cached': False,
                  'candidate_only': True, 'confirmation_required': True, 'cache_ttl_seconds': 300}
        retrieved = self.clock()
        try:
            status, payload = await asyncio.wait_for(self.transport(provider, query, limit), timeout=5)
            if status == 404 and provider == 'pubchem':
                candidates = []
            elif status != 200:
                result['status'] = 'unavailable'; return result
            else:
                candidates = parse_candidates(provider, payload, retrieved, limit)
        except (ValueError, KeyError, TypeError, AttributeError):
            result['status'] = 'malformed'; return result
        except Exception:
            result['status'] = 'unavailable'; return result
        total = payload.get('totalHits', len(candidates)) if isinstance(payload, dict) else len(candidates)
        if type(total) is not int or total < 0:
            result['status'] = 'malformed'; return result
        result.update(candidates=candidates, retrieved_at=retrieved,
                      status='no_result' if not candidates else 'ambiguous' if max(total, len(candidates)) > 1 else 'matches')
        self.cache[key] = (self.monotonic(), deepcopy(result))
        while len(self.cache) > 64:
            self.cache.popitem(last=False)
        return result

    async def accept(self, repository, *, provider, query, candidate_id, evidence_id, submitted_alias):
        result = await self.search(provider, query)
        selected = next((c for c in result['candidates'] if c['candidate_id'] == candidate_id
                         and c['evidence_id'] == evidence_id), None)
        if selected is None:
            raise ValueError('Evidence expired or changed; search and confirm again')
        if not selected['has_composition_profile']:
            raise ValueError('Identity-only candidate has no reusable composition profile')
        material = deepcopy(selected['material'])
        material['identity_status'] = 'owner_confirmed'
        record = await repository.save(material_id=selected['material_id'], material=material,
                                       submitted_alias=submitted_alias, kind=selected['catalog'])
        readback = next((p for p in await repository.list_active()
                         if p['id'] == record['id'] and p['version'] == record['version']), None)
        if readback is None:
            raise RuntimeError('Accepted profile readback failed')
        return readback
