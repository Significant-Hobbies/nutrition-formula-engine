import asyncio
import json
from pathlib import Path
import unittest
from nutrition_formula.provider_search import ProviderSearch, parse_candidates
from nutrition_formula.line_review import D1LineReviewRepository, source_rows
from nutrition_formula.material_profiles import D1MaterialProfileRepository
from test_versioning import FakeD1

FIXTURES = Path(__file__).parent / 'fixtures/providers'
def fixture(name):
    return json.loads((FIXTURES / (name + '.json')).read_text())

class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = 0; self.now = 0; self.payload = fixture('fdc'); self.status = 200
        async def transport(provider, query, limit):
            self.calls += 1
            return self.status, self.payload
        self.service = ProviderSearch(transport, clock=lambda: '2026-10-13T00:00:00Z', monotonic=lambda: self.now)

    async def test_provenance_accept_and_existing_profile_readback(self):
        result = await self.service.search('fdc', 'synthetic')
        c = result['candidates'][0]
        self.assertEqual(result['status'], 'matches')
        self.assertEqual(c['material']['nutrients']['protein']['value'], '1.25')
        self.assertNotIn('iron', c['material']['nutrients'])
        self.assertFalse(c['material']['unlisted_nutrients_are_zero'])
        db = FakeD1(); repo = D1MaterialProfileRepository(db, owner_id='fixture')
        accepted = await self.service.accept(repo, provider='fdc', query='synthetic', candidate_id=c['candidate_id'], evidence_id=c['evidence_id'], submitted_alias='test')
        again = await self.service.accept(repo, provider='fdc', query='synthetic', candidate_id=c['candidate_id'], evidence_id=c['evidence_id'], submitted_alias='test')
        self.assertEqual(accepted['version'], again['version'])
        self.assertEqual(accepted['source']['raw_evidence'], fixture('fdc')['foods'][0])
        self.assertEqual(len(await repo.list_active()), 1)

    async def test_cache_refresh_expiry_failure_and_bound(self):
        await self.service.search('fdc', 'a'); await self.service.search('fdc', 'a')
        self.assertEqual(self.calls, 1)
        self.status = 503
        failed = await self.service.search('fdc', 'a', refresh=True)
        self.assertEqual(failed['status'], 'unavailable'); self.assertEqual(failed['candidates'], [])
        self.status = 200; await self.service.search('fdc', 'a'); self.now = 301
        await self.service.search('fdc', 'a'); self.assertEqual(self.calls, 4)
        for i in range(70): await self.service.search('fdc', str(i))
        self.assertEqual(len(self.service.cache), 64)

    async def test_expired_changed_evidence_cannot_be_accepted(self):
        c = (await self.service.search('fdc', 'a'))['candidates'][0]
        self.now = 301; self.payload = fixture('outcomes')['no_result']
        with self.assertRaisesRegex(ValueError, 'expired'):
            await self.service.accept(None, provider='fdc', query='a', candidate_id=c['candidate_id'], evidence_id=c['evidence_id'], submitted_alias='a')

    async def test_explicit_outcomes_and_identity_only_ambiguity(self):
        outcomes = fixture('outcomes')
        for key, expected in [('no_result', 'no_result'), ('malformed', 'malformed')]:
            self.payload = outcomes[key]
            self.assertEqual((await self.service.search('fdc', key))['status'], expected)
        self.status = outcomes['unavailable']['status']
        self.assertEqual((await self.service.search('fdc', 'failed'))['status'], 'unavailable')
        self.status = 200; self.payload = fixture('pubchem')
        result = await self.service.search('pubchem', 'chemical')
        self.assertEqual(result['status'], 'ambiguous')
        self.assertFalse(result['candidates'][0]['has_composition_profile'])
        with self.assertRaisesRegex(ValueError, 'Identity-only'):
            c = result['candidates'][0]
            await self.service.accept(None, provider='pubchem', query='chemical', candidate_id=c['candidate_id'], evidence_id=c['evidence_id'], submitted_alias='x')
        self.payload = outcomes['pubchem_not_found']
        self.assertEqual((await self.service.search('pubchem', 'absent'))['status'], 'no_result')

    async def test_transport_failure_and_404(self):
        async def unavailable(*args): raise ConnectionError('Synthetic outage')
        service = ProviderSearch(unavailable)
        self.assertEqual((await service.search('fdc', 'x'))['status'], 'unavailable')
        self.assertEqual(len(service.cache), 0)
        self.status = 404
        self.assertEqual((await self.service.search('pubchem', 'missing'))['status'], 'no_result')
        self.assertEqual((await self.service.search('fdc', 'missing'))['status'], 'unavailable')
        self.status = 200; self.payload['totalHits'] = 20
        self.assertEqual((await self.service.search('fdc', 'many', limit=1))['status'], 'ambiguous')

    async def test_malformed_units_and_numeric_values(self):
        for value in ['NaN', '-1', 'invalid']:
            data = fixture('fdc'); data['foods'][0]['foodNutrients'][0]['value'] = value
            with self.assertRaises(ValueError): parse_candidates('fdc', data, 'now')
        data = fixture('fdc'); data['foods'][0]['foodNutrients'][0]['unitName'] = 'MG'
        with self.assertRaises(ValueError): parse_candidates('fdc', data, 'now')

class LineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.db = FakeD1()
        self.db.connection.executescript((Path(__file__).parents[1] / 'migrations/0005_line_review_decisions.sql').read_text())
        self.db.connection.execute("INSERT INTO formulas(id,created_at,current_version,access_token_hash,owner_id) VALUES ('fixture','now',1,'unused','test')")
        self.version = {'formula_id': 'fixture', 'input_fingerprint': 'immutable-input',
                        'report': {'formula_rows': [{'item': 'FINISHED BATCH'}, {'item': 'same', 'submitted_quantity': 'unknown'}, {'item': 'same', 'submitted_quantity': 'unknown'}]}}
        self.repo = D1LineReviewRepository(self.db, owner_id='test')
        self.rows = source_rows(self.version)

    def decision(self, state='search_pending', request_id='request', row=0):
        return {'source_row_id': self.rows[row]['source_row_id'], 'request_id': request_id,
                'state': state, 'rationale': 'Synthetic audit rationale', 'query': 'same', 'provider': 'fdc', 'candidate_id': 'fdc:900001'}

    async def test_retry_resume_duplicate_rows_and_owner_isolation(self):
        d = self.decision(); a = await self.repo.save(self.version, d)
        b = await self.repo.save(self.version, d); self.assertEqual(a, b)
        self.assertNotEqual(self.rows[0]['source_row_id'], self.rows[1]['source_row_id'])
        resumed = D1LineReviewRepository(self.db, owner_id='test')
        self.assertEqual(await resumed.list('fixture'), [a])
        self.assertEqual(a['source']['submitted_quantity'], 'unknown')
        self.assertEqual(await D1LineReviewRepository(self.db, owner_id='other').list('fixture'), [])
        with self.assertRaisesRegex(ValueError, 'different decision'):
            await self.repo.save(self.version, self.decision(row=1))
        self.assertEqual(len(await self.repo.list('fixture')), 1)

    async def test_all_states_remain_distinct_and_invalid_rows_rejected(self):
        for i, state in enumerate(['rejected_candidate', 'no_candidate', 'search_pending', 'provider_failure', 'malformed_response', 'ambiguous_candidates', 'search_results']):
            await self.repo.save(self.version, self.decision(state, str(i), i % 2))
        self.assertEqual(len(await self.repo.list('fixture')), 7)
        d = self.decision(); d['source_row_id'] = 'another-formula'
        with self.assertRaises(ValueError): await self.repo.save(self.version, d)
        d = self.decision(); d['rationale'] = ''
        with self.assertRaises(ValueError): await self.repo.save(self.version, d)

class WorkerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_search_and_accept_routes(self):
        from test_worker_routes import load_worker_module, Request
        from types import SimpleNamespace
        module = load_worker_module(); worker = module.Default(); db = FakeD1()
        worker.env = SimpleNamespace(FORMULA_DB=db)
        async def transport(provider, query, limit): return 200, fixture('fdc')
        worker._provider_search = ProviderSearch(transport, clock=lambda: '2026-10-13T00:00:00Z')
        result = await worker.fetch(Request('GET', '/api/ingredients/search?provider=fdc&q=synthetic'))
        self.assertEqual(result.status, 200)
        candidate = result.data['candidates'][0]
        accepted = await worker.fetch(Request('POST', '/api/ingredients', {
            'provider': 'fdc', 'query': 'synthetic', 'candidate_id': candidate['candidate_id'],
            'evidence_id': candidate['evidence_id'], 'submitted_alias': 'synthetic'}))
        self.assertEqual(accepted.status, 201)
        readback = await worker.fetch(Request('GET', '/api/ingredients'))
        self.assertEqual(readback.data['profiles'][0]['version'], accepted.data['profile']['version'])
        bad = await worker.fetch(Request('GET', '/api/ingredients/search?provider=unknown&q=x'))
        self.assertEqual(bad.status, 400)

    async def test_actual_review_routes_retry_readback_and_input_unchanged(self):
        from test_worker_routes import load_worker_module, Request
        from types import SimpleNamespace
        module = load_worker_module(); worker = module.Default(); db = FakeD1()
        db.connection.executescript((Path(__file__).parents[1] / 'migrations/0005_line_review_decisions.sql').read_text())
        worker.env = SimpleNamespace(FORMULA_DB=db)
        created = await worker.fetch(Request('POST', '/api/formulas', {
            'file_name': 'fixture.tsv', 'contents': 'Item\tQuantity\tUnit\nFINISHED BATCH\t1\tkg\nUnknown\t1\tg\nUnknown\t2\tg\n'}))
        self.assertEqual(created.status, 201)
        v = created.data['version']; url = f"/api/formulas/{v['formula_id']}/versions/1/review"
        review = await worker.fetch(Request('GET', url)); self.assertEqual(review.status, 200)
        d = {'source_row_id': review.data['rows'][0]['source_row_id'], 'request_id': 'retry',
             'state': 'no_candidate', 'rationale': 'Synthetic no result', 'query': 'unknown', 'provider': 'fdc'}
        first = await worker.fetch(Request('POST', url, d)); self.assertEqual(first.status, 200)
        second = await worker.fetch(Request('POST', url, d)); self.assertEqual(first.data, second.data)
        resumed = await worker.fetch(Request('GET', url)); self.assertEqual(len(resumed.data['decisions']), 1)
        self.assertNotEqual(review.data['rows'][0]['source_row_id'], review.data['rows'][1]['source_row_id'])
        unchanged = await worker.fetch(Request('GET', f"/api/formulas/{v['formula_id']}/versions/1"))
        self.assertEqual(unchanged.data['normalized_input'], v['normalized_input'])
        self.assertEqual(unchanged.data['report'], v['report'])
        d['source_row_id'] = 'bad'; self.assertEqual((await worker.fetch(Request('POST', url, d))).status, 400)
