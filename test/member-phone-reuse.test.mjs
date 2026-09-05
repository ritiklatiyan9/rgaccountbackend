import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeVerifiedKycProfile,
  normalizeMemberName,
  normalizeMemberPhone,
} from '../src/services/memberPhoneReuse.service.js';

test('mobile normalization accepts local, leading-zero and +91 formats only when complete', () => {
  assert.equal(normalizeMemberPhone('98765 43210'), '9876543210');
  assert.equal(normalizeMemberPhone('09876543210'), '9876543210');
  assert.equal(normalizeMemberPhone('+91 98765-43210'), '9876543210');
  assert.equal(normalizeMemberPhone('987654321'), '');
  assert.equal(normalizeMemberPhone('+1 9876543210'), '');
});

test('name matching ignores case, spaces and punctuation', () => {
  assert.equal(normalizeMemberName(' Rajesh-Kumar '), 'RAJESHKUMAR');
  assert.equal(normalizeMemberName('RAJESH KUMAR'), 'RAJESHKUMAR');
});

test('verified KYC fields replace retyped identity data without changing site roles', () => {
  const merged = mergeVerifiedKycProfile({
    site_id: 22,
    member_type: 'BROKER',
    member_types: ['BROKER', 'CLIENT'],
    team: 'SALES NORTH',
    status: 'ACTIVE',
    full_name: 'RAJESH KUMAR',
    phone: '9876543210',
    email: 'new@example.com',
  }, {
    full_name: 'RAJESH KUMAR',
    phone: '+91 98765 43210',
    email: 'verified@example.com',
    aadhar_no: '111122223333',
    aadhar_front_url: 'https://files.example/aadhaar-front.jpg',
    team: 'OLD TEAM',
    status: 'INACTIVE',
  });

  assert.equal(merged.site_id, 22);
  assert.equal(merged.member_type, 'BROKER');
  assert.deepEqual(merged.member_types, ['BROKER', 'CLIENT']);
  assert.equal(merged.team, 'SALES NORTH');
  assert.equal(merged.status, 'ACTIVE');
  assert.equal(merged.phone, '9876543210');
  assert.equal(merged.email, 'verified@example.com');
  assert.equal(merged.aadhar_no, '111122223333');
  assert.equal(merged.aadhar_front_url, 'https://files.example/aadhaar-front.jpg');
});

test('blank source values do not erase useful submitted values', () => {
  const merged = mergeVerifiedKycProfile(
    { full_name: 'ANITA DEVI', phone: '9123456789', email: 'anita@example.com' },
    { full_name: 'ANITA DEVI', phone: '9123456789', email: '' }
  );
  assert.equal(merged.email, 'anita@example.com');
});
