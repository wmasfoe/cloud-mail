import s3Service from './s3-service';
import settingService from './setting-service';
import kvObjService from './kv-obj-service';
import { settingConst } from '../const/entity-const';

const r2Service = {

	async storageType(c) {

		const setting = await settingService.query(c);
		const { bucket, endpoint, s3AccessKey, s3SecretKey } = setting;

		if (!!(bucket && endpoint && s3AccessKey && s3SecretKey)) {
			return 'S3';
		}

		if (c.env.r2) {
			return 'R2';
		}

		return 'KV';
	},

	async putObj(c, key, content, metadata) {

		const { kvStorage } = await settingService.query(c);

		if (kvStorage === settingConst.kvStorage.OPEN) {

			await kvObjService.putObj(c, key, content, metadata);

		} else if (c.env.r2) {

			await c.env.r2.put(key, content, {
				httpMetadata: { ...metadata }
			});

		} else {

			await s3Service.putObj(c, key, content, metadata);

		}

	},

	async getObj(c, key) {
		return await c.env.r2.get(key);
	},

	async delete(c, key) {

		const { kvStorage } = await settingService.query(c);

		if (kvStorage === settingConst.kvStorage.OPEN) {

			await kvObjService.deleteObj(c, key);

		} else if (c.env.r2) {

			await c.env.r2.delete(key);

		} else {

			await s3Service.deleteObj(c, key);

		}

	}

};
export default r2Service;
