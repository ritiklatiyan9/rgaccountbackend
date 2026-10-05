import test from 'node:test';
import assert from 'node:assert/strict';
import { relatedIdentityName } from '../src/services/memberIdentityNameMatch.js';

test('related names allow middle names, titles, punctuation and a minor spelling difference', () => {
  for (const name of ['RAHUL CHAUHAN', 'Rahul-Chauhan', 'SHRI RAHUL CHAUHAN', 'RAHUL KUMAR CHAUHAN', 'RAHUL CHOUHAN', 'RAHUL CHAUHAN (BROKER)']) {
    assert.equal(relatedIdentityName(name, 'RAHUL CHAUHAN'), true, name);
  }
});

test('a shared first name, surname or a distant spelling is insufficient', () => {
  for (const name of ['RAHUL TOMAR', 'SUBHASH CHOUDHARY', 'LOKENDRA SAROHA', 'KAPIL MALIK', 'MOHIT CHAUHAN', 'RAHUL', 'RAHUL CHAUDHARY']) {
    assert.equal(relatedIdentityName(name, 'RAHUL CHAUHAN'), false, name);
  }
  assert.equal(relatedIdentityName('RAHUL CHAUHAN', ''), false);
});

test('initial surnames are supported only for an existing linked identity', () => {
  assert.equal(relatedIdentityName('RAHUL T', 'RAHUL TOMAR'), false);
  assert.equal(relatedIdentityName('RAHUL T', 'RAHUL TOMAR', {allowInitials:true}), true);
  assert.equal(relatedIdentityName('RAHUL C', 'RAHUL TOMAR', {allowInitials:true}), false);
});
