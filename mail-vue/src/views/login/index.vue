<template>
  <div id="login-box" :style="background">
    <div id="background-wrap" v-if="!settingStore.settings.background">
      <div class="x1 cloud"></div>
      <div class="x2 cloud"></div>
      <div class="x3 cloud"></div>
      <div class="x4 cloud"></div>
      <div class="x5 cloud"></div>
    </div>
    <div class="form-wrapper">
        <div class="container">
          <span class="form-title">{{ settingStore.settings.title }}</span>
          <div class="custom-style" v-if="settingStore.settings.register === 0">
            <el-segmented v-model="show" :options="options"/>
          </div>
          <div v-if="show === 'login'">
            <el-input v-model="form.email" type="text" placeholder="邮箱" autocomplete="off">
              <template #prefix>
                <Icon icon="weui:email-outlined" width="22" height="22"/>
              </template>
              <template #append>
                <div @click.stop="openSelect">
                  <el-select
                      ref="mySelect"
                      v-model="suffix"
                      placeholder="请选择"
                      class="select"
                  >
                    <el-option
                        v-for="item in domainList"
                        :key="item"
                        :label="item"
                        :value="item"
                    />
                  </el-select>
                  <div style="color: #333">
                    <span>{{ suffix }}</span>
                    <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
                  </div>
                </div>
              </template>
            </el-input>
            <el-input v-model="form.password" placeholder="密码" type="password" autocomplete="off">
              <template #prefix>
                <Icon icon="carbon:password" width="22" height="22"/>
              </template>
            </el-input>
            <el-button class="btn" type="primary" @click="submit" :loading="loginLoading"
            >登录
            </el-button>
          </div>
          <div v-else>
            <el-input v-model="registerForm.email" type="text" placeholder="邮箱" autocomplete="off">
              <template #prefix>
                <Icon icon="weui:email-outlined" width="22" height="22"/>
              </template>
              <template #append>
                <div @click.stop="openSelect">
                  <el-select
                      ref="mySelect"
                      v-model="suffix"
                      placeholder="请选择"
                      class="select"
                  >
                    <el-option
                        v-for="item in domainList"
                        :key="item"
                        :label="item"
                        :value="item"
                    />
                  </el-select>
                  <div style="color: #333">
                    <span>{{ suffix }}</span>
                    <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
                  </div>
                </div>
              </template>
            </el-input>
            <el-input v-model="registerForm.password" placeholder="密码" type="password" autocomplete="off">
              <template #prefix>
                <Icon icon="carbon:password" width="22" height="22"/>
              </template>
            </el-input>
            <el-input v-model="registerForm.confirmPassword" placeholder="确认密码" type="password" autocomplete="off">
              <template #prefix>
                <Icon icon="carbon:password" width="22" height="22"/>
              </template>
            </el-input>
            <el-button class="btn" type="primary" @click="submitRegister" :loading="registerLoading"
            >注册
            </el-button>
          </div>
        </div>
    </div>
    <el-dialog
        v-model="verifyShow"
        title="验证你是不是人"
        width="332"
        align-center
    >
      <div
          class="register-turnstile"
          :data-sitekey="settingStore.settings.siteKey"
          data-callback="onTurnstileSuccess"
      ></div>
    </el-dialog>
  </div>
</template>

<script setup>
import router from "@/router";
import {computed, nextTick, reactive, ref} from "vue";
import {login} from "@/request/login.js";
import {register} from "@/request/login.js";
import {ElMessage} from 'element-plus'
import {isEmail} from "@/utils/verify-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useUserStore} from "@/store/user.js";
import {Icon} from "@iconify/vue";
import {cvtR2Url} from "@/utils/convert.js";
import {loginUserInfo} from "@/request/my.js";
import {permsToRouter} from "@/utils/perm.js";

const accountStore = useAccountStore();
const userStore = useUserStore();
const settingStore = useSettingStore();
const loginLoading = ref(false)
const show = ref('login')
const form = reactive({
  email: '',
  password: '',

});
const options = [{label: '登录', value: 'login'}, {label: '注册', value: 'register'}];
const mySelect = ref()
const suffix = ref('')
const registerForm = reactive({
  email: '',
  password: '',
  confirmPassword: ''
})
const domainList = settingStore.domainList;
const registerLoading = ref(false)
suffix.value = domainList[0]
const verifyShow = ref(false)
let verifyToken = ''
let turnstileId = ''

const background = computed(() => {

  return settingStore.settings.background ? {
    'background-image': `url(${cvtR2Url(settingStore.settings.background)})`,
    'background-repeat': 'no-repeat',
    'background-size': 'cover',
    'background-position': 'center'
  } : ''
})

window.onTurnstileSuccess = (token) => {
  verifyToken = token;
  setTimeout(() => {
    verifyShow.value = false
  }, 1500)
};

const openSelect = () => {
  mySelect.value.toggleMenu()
}


const submit = () => {

  if (!form.email) {
    ElMessage({
      message: '邮箱不能为空',
      type: 'error',
      plain: true,
    })
    return
  }

  if (!isEmail(form.email + suffix.value)) {
    ElMessage({
      message: '输入的邮箱不合法',
      type: 'error',
      plain: true,
    })
    return
  }

  if (!form.password) {
    ElMessage({
      message: '密码不能为空',
      type: 'error',
      plain: true,
    })
    return
  }

  loginLoading.value = true
  login(form.email + suffix.value, form.password).then(async data => {
    localStorage.setItem('token', data.token)
    const user = await loginUserInfo();
    accountStore.currentAccountId = user.accountId;
    userStore.user = user;
    const routers = permsToRouter(user.permKeys);
    routers.forEach(routerData => {
      router.addRoute('layout', routerData);
    });
    await router.replace({name: 'layout'})
  }).finally(() => {
    loginLoading.value = false
  })
}


function submitRegister() {

  if (!registerForm.email) {
    ElMessage({
      message: '邮箱不能为空',
      type: 'error',
      plain: true,
    })
    return
  }

  if (!isEmail(registerForm.email + suffix.value)) {
    ElMessage({
      message: '输入的邮箱不合法',
      type: 'error',
      plain: true,
    })
    return
  }

  if (!registerForm.password) {
    ElMessage({
      message: '密码不能为空',
      type: 'error',
      plain: true,
    })
    return
  }

  if (registerForm.password.length < 6) {
    ElMessage({
      message: '密码最少六位',
      type: 'error',
      plain: true,
    })
    return
  }

  if (registerForm.password !== registerForm.confirmPassword) {

    ElMessage({
      message: '两次密码输入不一致',
      type: 'error',
      plain: true,
    })
    return
  }

  if (!verifyToken && settingStore.settings.registerVerify === 0) {
    verifyShow.value = true
    if (!turnstileId) {
      nextTick(() => {
        turnstileId = window.turnstile.render('.register-turnstile')
      })
    } else {
      nextTick(() => {
        window.turnstile.reset(turnstileId);
      })
    }
    return;
  }

  registerLoading.value = true
  register({email: registerForm.email + suffix.value, password: registerForm.password, token: verifyToken}).then(() => {
    show.value = 'login'
    registerForm.email = ''
    registerForm.password = ''
    registerForm.confirmPassword = ''
    registerLoading.value = false
    verifyToken = ''
    ElMessage({
      message: '注册成功',
      type: 'success',
      plain: true,
    })
  }).catch(res => {
    if (res.code === 400) {
      verifyToken = ''
      window.turnstile.reset(turnstileId)
      verifyShow.value = true
    }
    registerLoading.value = false
  });
}

</script>

<style lang="scss" scoped>

.form-wrapper {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 110;
  display: flex;
  align-items: center;
  justify-content: center;
}

.container {
  max-width: 380px;
  background: #FFFFFF;
  padding: 20px;
  margin: 0 20px;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  border: 1px solid #e4e7ed;
  box-shadow: var(--el-box-shadow-light);
  .switch {
    padding-top: 10px;
    font-size: 14px;
  }

  .btn {
    width: 100%;
  }

  .form-title {
    font-weight: bold;
    font-size: 18px;
    margin-bottom: 20px;
  }

  .el-input {
    width: 100%;
    margin-bottom: 15px;
  }
}


.setting-icon {
  position: relative;
  top: 6px;
}

:deep(.el-input-group__append) {
  padding: 0 !important;
  padding-left: 8px !important;
  background: #FFFFFF;
}

.select {
  position: absolute;
  right: 30px;
  width: 100px;
  opacity: 0;
  pointer-events: none;
}

.custom-style {
  margin-bottom: 10px;
}

.custom-style .el-segmented {
  --el-border-radius-base: 6px;
  width: 180px;
}

#login-box {
  background: linear-gradient(to bottom, #2980b9, #6dd5fa, #fff);
  color: #333;
  font: 100% Arial, sans-serif;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow-x: hidden;
}


#background-wrap {
  height: 100%;
  z-index: 0;
}

@keyframes animateCloud {
  0% {
    margin-left: -500px;
  }

  100% {
    margin-left: 100%;
  }
}

.x1 {
  animation: animateCloud 30s linear infinite;
  transform: scale(0.65);
}

.x2 {
  animation: animateCloud 15s linear infinite;
  transform: scale(0.3);
}

.x3 {
  animation: animateCloud 25s linear infinite;
  transform: scale(0.5);
}

.x4 {
  animation: animateCloud 13s linear infinite;
  transform: scale(0.4);
}

.x5 {
  animation: animateCloud 20s linear infinite;
  transform: scale(0.55);
}

.cloud {
  background: linear-gradient(to bottom, #fff 5%, #f1f1f1 100%);
  border-radius: 100px;
  box-shadow: 0 8px 5px rgba(0, 0, 0, 0.1);
  height: 120px;
  width: 350px;
  position: relative;
}

.cloud:after,
.cloud:before {
  content: "";
  position: absolute;
  background: #fff;
  z-index: -1;
}

.cloud:after {
  border-radius: 100px;
  height: 100px;
  left: 50px;
  top: -50px;
  width: 100px;
}

.cloud:before {
  border-radius: 200px;
  height: 180px;
  width: 180px;
  right: 50px;
  top: -90px;
}

</style>
