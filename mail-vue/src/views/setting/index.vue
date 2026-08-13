<template>
  <div class="box">
    <div class="container">
      <div class="title">{{$t('profile')}}</div>
      <div class="item">
        <div>{{$t('username')}}</div>
        <div>
          <span v-if="setNameShow" class="edit-name-input">
            <el-input v-model="accountName"  ></el-input>
            <span class="edit-name" @click="setName">
             {{$t('save')}}
            </span>
          </span>
          <span v-else class="user-name">
            <span >{{ userStore.user.name }}</span>
            <span class="edit-name" @click="showSetName">
             {{$t('change')}}
            </span>
          </span>
        </div>
      </div>
      <div class="item">
        <div>{{$t('emailAccount')}}</div>
        <div>{{ userStore.user.email }}</div>
      </div>
      <div class="item">
        <div>{{$t('password')}}</div>
        <div>
          <el-button type="primary" @click="pwdShow = true">{{$t('changePwdBtn')}}</el-button>
        </div>
      </div>
    </div>
    <div class="language">
      <div class="title">{{$t('language')}}</div>
      <el-select
          :model-value="langSelect"
          class="language-select"
          placeholder="Select"
          @change="changeLang"
      >
        <el-option label="中文" value="zh" @pointerdown.prevent.stop="changeLang('zh')"/>
        <el-option label="English" value="en" @pointerdown.prevent.stop="changeLang('en')"/>
      </el-select>
    </div>
    <div class="push">
      <div class="title">🔔 通知推送</div>
      <div class="item">
        <div>
          <div>网页推送通知</div>
          <div class="push-tip">添加到主屏幕后,新邮件实时提醒(子邮箱可单独关闭)</div>
        </div>
        <el-switch :model-value="pushEnabled" :loading="pushSwitching" @change="togglePush"/>
      </div>
      <div class="item" v-for="acc in subAccounts" :key="acc.accountId">
        <div>{{ acc.email }}</div>
        <el-switch :model-value="!!acc.pushEnabled" :loading="subSwitching === acc.accountId" @change="(v) => setSubPush(acc, v)"/>
      </div>
    </div>
    <div class="del-email" v-perm="'my:delete'">
      <div class="title">{{$t('deleteUser')}}</div>
      <div style="color: var(--regular-text-color);">
        {{$t('delAccountMsg')}}
      </div>
      <div>
        <el-button type="primary" @click="deleteConfirm">{{$t('deleteUserBtn')}}</el-button>
      </div>
    </div>
    <el-dialog v-model="pwdShow" :title="$t('changePassword')" width="340">
      <div class="update-pwd">
        <el-input type="password" :placeholder="$t('newPassword')" v-model="form.password" autocomplete="off"/>
        <el-input type="password" :placeholder="$t('confirmPassword')" v-model="form.newPwd" autocomplete="off"/>
        <el-button type="primary" :loading="setPwdLoading" @click="submitPwd">{{$t('save')}}</el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import {reactive, ref, defineOptions} from 'vue'
import {resetPassword, userDelete} from "@/request/my.js";
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import {accountSetName} from "@/request/account.js";
import {useAccountStore} from "@/store/account.js";
import {useI18n} from "vue-i18n";
import {useSettingStore} from "@/store/setting.js";
import {accountSetPushEnabled, pushSubscribe, pushUnsubscribe, pushVapidKey} from "@/request/push.js";
import {accountList} from "@/request/account.js";
import {ElMessage} from "element-plus";

const { t } = useI18n()
const accountStore = useAccountStore()
const settingStore = useSettingStore()
const userStore = useUserStore();
const setPwdLoading = ref(false)
const setNameShow = ref(false)
const accountName = ref(null)
const langSelect = ref(settingStore.lang)
const pushEnabled = ref(false)
const subAccounts = ref([])
const pushSwitching = ref(false)
const subSwitching = ref(0)
let vapidKeyCache = null   // 预取 VAPID 公钥,点击开关时免网络请求

/** base64url → Uint8Array(applicationServerKey 格式) */
function b64urlToUint8Array(b64) {
    const padding = '='.repeat((4 - (b64.length % 4)) % 4);
    const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

/** 页面加载:读取当前订阅状态 + 子邮箱列表 */
async function loadPushState() {
    // 子邮箱列表(含 pushEnabled)
    try {
        const resp = await accountList(0, 100, 9999999999);
        const list = Array.isArray(resp) ? resp : (resp?.data || []);
        subAccounts.value = list;
        console.log('[push] 子邮箱列表:', list.length, list.map(a => a.email).join(','));
    } catch (e) {
        console.error('[push] 子邮箱列表加载失败:', e);
        ElMessage.error('子邮箱列表加载失败:' + (e?.message || '未知错误'));
    }
    // 预取 VAPID 公钥(首次进设置页就取,点开关时直接用)
    try {
        const resp = await pushVapidKey();
        vapidKeyCache = resp?.publicKey || resp?.data?.publicKey || null;
    } catch (e) { /* 点击开关时再取 */ }
    // 当前推送订阅状态
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            pushEnabled.value = !!sub;
        } catch (e) { /* 忽略 */ }
    }
}

/** 启用网页推送 */
async function togglePush(v) {
    if (pushSwitching.value) return;   // 防重复点击
    pushSwitching.value = true;
    try {
        if (v) {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
                ElMessage.warning('当前浏览器不支持网页推送(需 iOS 16.4+ / 现代浏览器)');
                return;
            }
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                ElMessage.warning('未获得通知权限');
                return;
            }
            try {
                const reg = await navigator.serviceWorker.ready;
                let key = vapidKeyCache;
                if (!key) {
                    const resp = await pushVapidKey();
                    key = resp?.publicKey || resp?.data?.publicKey;
                }
                if (!key) {
                    ElMessage.error('获取推送密钥失败');
                    return;
                }
                // 首次注册:浏览器与推送服务(APNs)握手,需几秒~十几秒,属正常
                const sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: b64urlToUint8Array(key),
                });
                const j = sub.toJSON();
                await pushSubscribe(j.endpoint, j.keys.p256dh, j.keys.auth);
                pushEnabled.value = true;
                ElMessage.success('已开启推送');
            } catch (e) {
                ElMessage.error('开启失败:' + e.message);
            }
        } else {
            try {
                const reg = await navigator.serviceWorker.ready;
                const sub = await reg.pushManager.getSubscription();
                if (sub) {
                    await pushUnsubscribe(sub.endpoint);
                    await sub.unsubscribe();
                }
                pushEnabled.value = false;
                ElMessage.success('已关闭推送');
            } catch (e) {
                ElMessage.error('关闭失败:' + e.message);
            }
        }
    } finally {
        pushSwitching.value = false;
    }
}

/** 子邮箱推送开关 */
async function setSubPush(acc, v) {
    if (subSwitching.value) return;    // 防重复点击
    subSwitching.value = acc.accountId;
    try {
        await accountSetPushEnabled(acc.accountId, v ? 1 : 0);
        acc.pushEnabled = v ? 1 : 0;
        ElMessage.success(v ? `已开启 ${acc.email} 推送` : `已关闭 ${acc.email} 推送`);
    } catch (e) {
        ElMessage.error('设置失败:' + e.message);
    } finally {
        subSwitching.value = 0;
    }
}

loadPushState()

defineOptions({
  name: 'setting'
})

function showSetName() {
  accountName.value = userStore.user.name
  setNameShow.value = true
}

function setName() {

  if (!accountName.value) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameShow.value = false
  let name = accountName.value

  if (name === userStore.user.name) {
    return
  }

  userStore.user.name = accountName.value

  accountSetName(userStore.user.account.accountId,name).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })

    accountStore.changeUserAccountName = name

  }).catch(() => {
    userStore.user.name = name
  })
}

function changeLang(lang) {
  let setting = {}
  try {
    setting = JSON.parse(localStorage.getItem('setting') || '{}')
  } catch (e) {
    setting = {}
  }
  localStorage.setItem('setting', JSON.stringify({...setting, lang}))
  window.location.reload()
}

const pwdShow = ref(false)
const form = reactive({
  password: '',
  newPwd: '',
})

const deleteConfirm = () => {
  ElMessageBox.confirm(t('delAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    userDelete().then(() => {
      localStorage.removeItem('token');
      router.replace('/login');
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}


function submitPwd() {

  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.password !== form.newPwd) {
    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  setPwdLoading.value = true
  resetPassword(form.password).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pwdShow.value = false
    setPwdLoading.value = false
    form.password = ''
    form.newPwd = ''
  }).catch(() => {
    setPwdLoading.value = false
  })

}

</script>
<style scoped lang="scss">
.box {
  padding: 40px 40px;

  @media (max-width: 767px) {
    padding: 30px 30px;
  }

  .update-pwd {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .container {
    font-size: 14px;
    display: grid;
    gap: 20px;
    margin-bottom: 40px;

    .item {
      display: grid;
      grid-template-columns: 50px 1fr;
      gap: 140px;
      position: relative;
      .user-name {
        display: grid;
        grid-template-columns: auto 1fr;
        span:first-child {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }

      .edit-name-input {
        position: absolute;
        bottom: -6px;
        .el-input {
          width: min(200px,calc(100vw - 222px));
        }
      }

      .edit-name {
        color: #4dabff;
        padding-left: 10px;
        cursor: pointer;
      }

      @media (max-width: 767px) {
        gap: 70px;
      }

      div:first-child {
        font-weight: bold;
      }

      div:last-child {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
    }
  }

  .language {
    display: flex;
    flex-direction: column;
    gap: 20px;
    margin-bottom: 40px;

    .language-select {
      width: 100px;
    }
  }

  .del-email {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
}
</style>
