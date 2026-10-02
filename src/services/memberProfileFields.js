export const MEMBER_FIELDS = [
  'member_type', 'full_name', 'father_name', 'gender', 'date_of_birth', 'blood_group',
  'phone', 'alt_phone', 'email', 'whatsapp',
  'address', 'city', 'state', 'pincode',
  'aadhar_no', 'pan_no', 'voter_id',
  'bank_name', 'account_no', 'ifsc_code', 'branch',
  'occupation', 'company_name', 'reference', 'notes', 'status',
  // New personal fields
  'mother_name', 'spouse_name', 'nationality', 'religion', 'caste',
  'marital_status', 'anniversary_date', 'qualification',
  // Additional identity
  'passport_no', 'driving_license_no', 'gst_no', 'tin_no',
  // Emergency contact
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  // Co-applicant (joint applicant)
  'co_applicant_name', 'co_applicant_relation', 'co_applicant_dob', 'co_applicant_gender',
  'co_applicant_phone', 'co_applicant_email', 'co_applicant_aadhar', 'co_applicant_pan',
  'co_applicant_address', 'permanent_address',
  // Nominee
  'nominee_name', 'nominee_relation', 'nominee_phone',
  // Employee-specific
  'employee_id', 'designation', 'department', 'date_of_joining', 'salary', 'employment_type',
  // Farmer-specific
  'land_area', 'crop_type', 'farm_location', 'irrigation_type', 'farming_experience',
  // Broker-specific
  'license_number', 'commission_rate', 'operating_areas',
  // Vendor-specific
  'business_name', 'service_type', 'payment_terms',
  // Team (for broker/member/employee/partner)
  'team',
  // Location (migration 108) — geocode_source/precision/geocoded_at are set server-side, never from the client
  'latitude', 'longitude', 'village', 'district',
];

export const DOC_FIELDS = [
  'photo', 'aadhar_front_url', 'aadhar_back_url', 'pan_card_url',
  'voter_id_url', 'passport_url', 'driving_license_url', 'cheque_url', 'other_kyc_url',
  'resume_url', 'marksheet_10th_url', 'marksheet_12th_url',
  'degree_certificate_url', 'experience_certificate_url',
  'offer_letter_url', 'other_certificate_url',
];
