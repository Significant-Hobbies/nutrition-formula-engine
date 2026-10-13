"""Append-only source-snapshot scoped decisions; no change to calculation input."""
from .versioning import canonical_json, d1_results, fingerprint
from .provider_search import utc_now
import json

STATES = {'search_pending', 'rejected_candidate', 'no_candidate', 'provider_failure',
          'malformed_response', 'ambiguous_candidates', 'search_results'}


def source_rows(version):
    # Immutable snapshot and ordinal distinguish even identical duplicate rows.
    return [{'source_row_id': fingerprint({'formula_id': version['formula_id'],
             'input_fingerprint': version['input_fingerprint'], 'ordinal': ordinal}),
             'ordinal': ordinal, 'source': row}
            for ordinal, row in enumerate(version['report']['formula_rows']) if ordinal > 0]


class D1LineReviewRepository:
    def __init__(self, database, *, owner_id='legacy', clock=utc_now):
        self.database, self.owner_id, self.clock = database, owner_id, clock

    async def list(self, formula_id):
        result = await self.database.prepare(
            'SELECT payload_json, created_at, sequence FROM line_review_decisions '
            'WHERE owner_id = ?1 AND formula_id = ?2 ORDER BY sequence'
        ).bind(self.owner_id, formula_id).run()
        return [{**json.loads(r['payload_json']), 'created_at': r['created_at'],
                 'sequence': r['sequence']} for r in d1_results(result)]

    async def save(self, version, decision):
        if not isinstance(decision, dict):
            raise ValueError('Decision object required')
        row = next((r for r in source_rows(version) if r['source_row_id'] == decision.get('source_row_id')), None)
        if row is None:
            raise ValueError('Source row does not belong to this input snapshot')
        for field in ['request_id', 'rationale']:
            if not isinstance(decision.get(field), str) or not 1 <= len(decision[field].strip()) <= (2000 if field == 'rationale' else 160):
                raise ValueError(f'{field} required and bounded')
        state = decision.get('state')
        if state not in STATES:
            raise ValueError('Invalid decision state')
        for field in ['candidate_id', 'query', 'provider', 'evidence_id', 'retrieved_at']:
            value = decision.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > 320):
                raise ValueError(f'Invalid {field}')
        if state == 'rejected_candidate' and not decision.get('candidate_id'):
            raise ValueError('Rejected candidate identity required')
        if state in STATES - {'rejected_candidate'} and not decision.get('query'):
            raise ValueError('Search query required')
        if state in {'provider_failure', 'malformed_response'} and decision.get('provider') not in {'fdc', 'pubchem'}:
            raise ValueError('Provider identity required')
        if decision.get('candidate_source') is not None and not isinstance(decision['candidate_source'], dict):
            raise ValueError('Candidate source must be an object')
        payload = {k: decision.get(k) for k in ['request_id', 'source_row_id', 'state', 'rationale',
                    'candidate_id', 'query', 'provider', 'evidence_id', 'retrieved_at', 'candidate_source']}
        payload.update(source=row['source'], input_fingerprint=version['input_fingerprint'])
        encoded = canonical_json(payload)
        if len(encoded.encode()) > 16000:
            raise ValueError('Decision too large')
        await self.database.prepare(
            'INSERT INTO line_review_decisions(owner_id, formula_id, source_row_id, request_id, payload_json, created_at) '
            'VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(owner_id, formula_id, request_id) DO NOTHING'
        ).bind(self.owner_id, version['formula_id'], row['source_row_id'], payload['request_id'], encoded, self.clock()).run()
        readback = next(r for r in await self.list(version['formula_id']) if r['request_id'] == payload['request_id'])
        if canonical_json({k: readback[k] for k in payload}) != encoded:
            raise ValueError('Retry request_id already used for a different decision')
        return readback
