package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type serverConfig struct {
	Listen      string `json:"listen"`
	AllowRemote bool   `json:"allow_remote"`
}

// 配置文件可省略；手机连接和 AI 设置仍由网页管理并保存在数据库中。
func loadServerConfig(path string) (serverConfig, error) {
	c := serverConfig{Listen: "127.0.0.1:8787"}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, fmt.Errorf("读取服务配置失败：%w", err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("解析服务配置失败：%w", err)
	}
	if c.Listen == "" {
		return c, fmt.Errorf("服务配置 listen 不能为空")
	}
	return c, nil
}
