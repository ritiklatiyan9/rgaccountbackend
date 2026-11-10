// Reuses the existing AWS sender. Template submission and assignment send no customer messages.
import 'dotenv/config';
import pool from '../src/config/db.js';
import { createAccountWhatsAppTemplate, refreshAccountWhatsAppTemplates, saveAccountWhatsAppStage } from '../src/services/accountWhatsApp.service.js';
import { compileAccountWhatsAppBody } from '../src/services/accountWhatsApp.spec.js';
import { OVERDUE_POLICY_KEY, PENDING_OVERDUE_TEMPLATE_KEY, overdueTemplateBody } from '../src/services/installmentOverduePolicy.service.js';

const event = 'INSTALLMENT_OVERDUE';
const plans = [
  {
    site_id: 5, name: 'OM ASSOCIATES', title: 'OM ASSOCIATES overdue interest notice',
    body: '*OM ASSOCIATES - overdue installment penalty*\n\nDear {customer_name},\n\nYour {installment_name} for Plot {plot_no} at {project}, due on {due_date}, remains unpaid.\n*Unpaid overdue installment:* {amount_due}\n\n18% overdue interest is calculated only on the unpaid installment amount that has become due. Future installments are excluded.\n\nPlease settle the overdue installment. If you have already paid, contact our office to reconcile your account.\n\nDefence Garden Group',
  },
  {
    site_id: 7, name: 'Naya Baazar Unn Commercial', title: 'Naya Baazar shop overdue penalty notice',
    body: '*Naya Baazar - overdue shop installment penalty*\n\nDear {customer_name},\n\nYour {installment_name} for Shop {plot_no} at {project}, due on {due_date}, remains unpaid.\n*Unpaid overdue installment:* {amount_due}\n\nIf any installment is overdue, a Rs. 50,000 increase in the shop price applies.\n\nPlease settle the overdue installment. If you have already paid, contact our office to reconcile your account.\n\nDefence Garden Group',
  },
];
plans[0].policy = { enabled: true, kind: 'annual_interest', annual_rate: 18, frequency: 'per_installment' };
plans[1].policy = { enabled: true, kind: 'shop_price_increase', amount: 50000, frequency: 'once_per_shop' };
for (const plan of plans) plan.body = overdueTemplateBody(plan.policy);

try {
  for (const plan of plans) compileAccountWhatsAppBody(event, plan.body);
  if (!process.argv.includes('--submit') && !process.argv.includes('--apply-approved') && !process.argv.includes('--enable-approved')) {
    console.log(JSON.stringify(plans, null, 2));
  } else {
    const adminId = Number(process.argv.find((arg) => arg.startsWith('--admin-id='))?.split('=')[1]);
    const admin = (await pool.query("SELECT id,role,organization_id FROM users WHERE id=$1 AND is_active AND role IN ('admin','super_admin')", [adminId])).rows[0];
    if (!admin) throw new Error('Supply an active administrator with --admin-id=<id>');
    for (const plan of plans) {
      const site = (await pool.query('SELECT name FROM sites WHERE id=$1 AND organization_id=$2', [plan.site_id, admin.organization_id])).rows[0];
      if (site?.name !== plan.name) throw new Error(`Site identity mismatch for ${plan.site_id}`);
      if (process.argv.includes('--configure')) {
        await pool.query(
          `INSERT INTO application_settings(site_id,setting_key,setting_value,updated_by) VALUES($1,$2,$3,$4)
           ON CONFLICT(site_id,setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [plan.site_id, OVERDUE_POLICY_KEY, plan.policy, admin.id],
        );
      }
      let template = (await pool.query("SELECT * FROM account_whatsapp_templates WHERE site_id=$1 AND event=$2 AND body=$3 AND status NOT IN ('DELETED','REJECTED','SUBMISSION_FAILED') AND archived_at IS NULL ORDER BY id DESC LIMIT 1", [plan.site_id, event, plan.body])).rows[0];
      if (!template && process.argv.includes('--submit'))
        template = await createAccountWhatsAppTemplate(admin, { ...plan, event, category: 'UTILITY' });
      if (!template) throw new Error(`No submitted template for ${plan.name}`);
      await refreshAccountWhatsAppTemplates(pool, undefined, plan.site_id);
      template = (await pool.query('SELECT * FROM account_whatsapp_templates WHERE id=$1', [template.id])).rows[0];
      if ((process.argv.includes('--apply-approved') || process.argv.includes('--enable-approved')) && template.status === 'APPROVED') {
        const previous = (await pool.query('SELECT * FROM account_whatsapp_stage_settings WHERE site_id=$1 AND event=$2', [plan.site_id, event])).rows[0];
        if ((previous?.enabled && previous?.template_name !== template.name) || (previous?.template_name && previous.template_name !== template.name))
          throw new Error(`Review the existing overdue assignment for ${plan.name} before replacing it`);
        await saveAccountWhatsAppStage(admin, event, { site_id: plan.site_id, template_name: template.name, enabled: process.argv.includes('--enable-approved') });
      }
      if (process.argv.includes('--enable-approved') && template.status === 'PENDING') {
        const existing = (await pool.query('SELECT template_name,enabled FROM account_whatsapp_stage_settings WHERE site_id=$1 AND event=$2', [plan.site_id, event])).rows[0];
        if (existing?.enabled || existing?.template_name) throw new Error(`Review the existing overdue assignment for ${plan.name}`);
        await pool.query(
          `INSERT INTO application_settings(site_id,setting_key,setting_value,updated_by) VALUES($1,$2,$3,$4)
           ON CONFLICT(site_id,setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [plan.site_id, PENDING_OVERDUE_TEMPLATE_KEY, { template_name: template.name, policy: plan.policy, requested_by: admin.id, requested_at: new Date().toISOString() }, admin.id],
        );
      }
      console.log(JSON.stringify({ site_id: plan.site_id, project: plan.name, name: template.name, meta_template_id: template.meta_template_id, status: template.status, category: template.category, rejected_reason: template.rejected_reason, body: template.body }));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
