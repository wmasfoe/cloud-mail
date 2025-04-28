<template>
  <el-scrollbar class="scroll">
    <div>
      <div class="title" >
        <Icon icon="mdi:email-outline" width="24" height="24" />
        <div>{{settingStore.settings.title}}</div>
      </div>
      <el-menu :collapse="false" text-color="#fff" active-text-color="#fff" style="margin-top: 10px">
        <el-menu-item @click="router.push('/email')" index="email"
                      :class="route.meta.name === 'email' ? 'choose-item' : ''">
          <Icon icon="hugeicons:mailbox-01" width="20" height="20" />
          <span class="menu-name" style="margin-left: 21px">收件箱</span>
        </el-menu-item>
        <el-menu-item @click="router.push('/star')" index="star"
                      :class="route.meta.name === 'star' ? 'choose-item' : ''">
          <Icon icon="solar:star-line-duotone" width="20" height="20" />
          <span class="menu-name" style="margin-left: 20px">星标邮件</span>
        </el-menu-item>
        <el-menu-item @click="router.push('/setting')" index="setting"
                      :class="route.meta.name === 'setting' ? 'choose-item' : ''">
          <Icon icon="fluent:settings-48-regular" width="20" height="20" />
          <span class="menu-name" style="margin-left: 20px">个人设置</span>
        </el-menu-item>
        <el-menu-item @click="router.push('/sys-setting')" index="sys-setting"  v-if="userStore.user.type === 0"
                      :class="route.meta.name === 'sys-setting' ? 'choose-item' : ''">
          <Icon icon="eos-icons:system-ok-outlined" width="18" height="18" />
          <span class="menu-name" style="margin-left: 23px">系统设置</span>
        </el-menu-item>
      </el-menu>
    </div>
  </el-scrollbar>
  <div class="github">
    <a href="https://github.com/LaziestRen/cloud-mail">
      <Icon icon="codicon:github-inverted" width="28" height="28" />
    </a>
  </div>
</template>

<script setup>
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import { useRoute } from "vue-router";
import {Icon} from "@iconify/vue";
import {useSettingStore} from "@/store/setting.js";

const settingStore = useSettingStore();
const userStore = useUserStore();
const route = useRoute();
</script>

<style lang="scss" scoped>

.title {
  margin: 15px 10px;
  height: 50px;
  border-radius: 8px;
  display: flex;
  position: relative;
  font-size: 16px;
  font-weight: bold;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: #ffffff;
  background: linear-gradient(135deg, #1890ff, #1c6dd0);
  box-shadow: 0 0 12px rgba(24, 144, 255, 0.6), 0 0 20px rgba(24, 144, 255, 0.4);
  transition: all 0.3s ease;

  :deep(.el-icon) {
    font-size: 20px;
  }

  .user-right-icon {
    align-self: center;
    position: absolute;
    font-size: 12px;
    right: 8px;
    color: #ffffff;
  }

}



.el-menu-item {
  margin: 5px 10px !important;
  border-radius: 8px;
  height: 36px;
  padding: 10px !important;
}

.choose-item {
  font-weight: bold;
  background: rgba(255, 255, 255, 0.08) !important;
  backdrop-filter: blur(4px);
}

@media (hover: hover) {
  .el-menu-item:hover {
    background: rgba(255, 255, 255, 0.08) !important;
  }
}

.menu-name {
  user-select: none;
}


:deep(.el-scrollbar__wrap--hidden-default ) {
  background: #001529 !important;
}

:deep(.el-menu-item) {
  background: #001529;
}

:deep(.el-menu) {
  background: #001529;
}

.el-menu {
  border-right: 0;
  width: 250px;
  @media (max-width: 1199px) {
    width: 200px;
  }
}

:deep(.el-divider__text) {
  background: #001529;
  color: #FFFFFF;
}

.scroll {
  box-shadow: 6px 0 20px rgba(0, 21, 41, 0.35);
}

.github {
  position: absolute;
  width: 100%;
  bottom: 10px;
  display: flex;
  justify-content: center;
  a{
    color: #fff;
  }
}
</style>
