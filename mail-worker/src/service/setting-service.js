import KvConst from '../const/kv-const';
import setting from '../entity/setting';
import orm from '../entity/orm';
import { settingConst } from '../const/entity-const';
import BizError from "../error/biz-error";

const settingService = {

	async refresh(c) {
		const settingRow = await orm(c).select().from(setting).get();
		await c.env.kv.put(KvConst.SETTING, JSON.stringify(settingRow));
	},

	async query(c) {
		const setting = await c.env.kv.get(KvConst.SETTING, { type: 'json' });
		let domainList = c.env.domain;
		domainList = domainList.map(item => '@' + item);
		setting.domainList = domainList;
		setting.siteKey = c.env.site_key;
		setting.r2Domain = c.env.r2_domain;
		return setting;
	},

	async set(c, params) {
		if (params.registerVerify === 0 || params.addEmailVerify === 0) {
			if (!c.env.site_key || !c.env.secret_key) {
				throw new BizError('Turnstile密钥未配置,不能开启人机验证')
			}
		}
		await orm(c).update(setting).set({ ...params }).returning().get();
		await this.refresh(c);
	},

	async isRegister(c) {
		const { register } = await this.query(c);
		return register === settingConst.register.OPEN;
	},

	async isReceive(c) {
		const { receive } = await this.query(c);
		return receive === settingConst.receive.OPEN;
	},

	async isAddEmail(c) {
		const { addEmail, manyEmail } = await this.query(c);
		return addEmail === settingConst.addEmail.OPEN && manyEmail === settingConst.manyEmail.OPEN;
	},

	async isRegisterVerify(c) {
		const { registerVerify } = await this.query(c);
		return registerVerify === settingConst.registerVerify.OPEN;
	},

	async isAddEmailVerify(c) {
		const { addEmailVerify } = await this.query(c);
		return addEmailVerify === settingConst.addEmailVerify.OPEN;
	}
};

export default settingService;
