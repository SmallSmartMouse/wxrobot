package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// 图片统一存为 JPEG，文件名是内容的 SHA-256，网页通过 /api/media/{hash} 访问。

// mediaPath 返回图片文件路径；hash 必须是 64 位十六进制（防止路径穿越），否则返回 false。
func (a *App) mediaPath(hash string) (string, bool) {
	if b, err := hex.DecodeString(hash); err != nil || len(b) != sha256.Size {
		return "", false
	}
	return filepath.Join(filepath.Dir(a.path), "media", hash+".jpg"), true
}

// storeJPEG 按内容哈希保存图片并返回哈希；同一张图只存一份。
func (a *App) storeJPEG(data []byte) (string, error) {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	path, _ := a.mediaPath(hash)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	// 先写临时文件再改名，避免读到写了一半的文件
	if err := os.WriteFile(path+".tmp", data, 0600); err != nil {
		return "", err
	}
	return hash, os.Rename(path+".tmp", path)
}

// saveThumbnail 保存手机截取的聊天图片缩略图，返回哈希或错误说明。
func (a *App) saveThumbnail(b64 string) (hash, problem string) {
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(data) > 400000 {
		return "", "图片编码无效或过大"
	}
	// 只检查 JPEG 头和尺寸（不超过手机屏幕），不重新编码
	if cfg, err := jpeg.DecodeConfig(bytes.NewReader(data)); err != nil || cfg.Width > 1080 || cfg.Height > 1920 {
		return "", "图片格式或尺寸无效"
	}
	if hash, err = a.storeJPEG(data); err != nil {
		return "", "图片保存失败"
	}
	return hash, ""
}

// saveImage 保存上传或 AI 生成的 PNG/JPEG（可带 data: 前缀），转为 JPEG。
func (a *App) saveImage(encoded string) (string, error) {
	// 去掉浏览器上传时带的 data:image/...;base64, 前缀
	if prefix, rest, ok := strings.Cut(encoded, ","); ok && strings.HasPrefix(prefix, "data:") {
		if prefix != "data:image/png;base64" && prefix != "data:image/jpeg;base64" {
			return "", errors.New("只支持 PNG 或 JPEG 图片")
		}
		encoded = rest
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", errors.New("图片编码无效")
	}
	// 先只读头部检查格式和尺寸，避免解码超大图片
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") || cfg.Width > 4096 || cfg.Height > 4096 {
		return "", errors.New("只支持 4096×4096 以内的 PNG 或 JPEG 图片")
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", errors.New("图片已损坏")
	}
	// 统一转成 JPEG 保存
	var buf bytes.Buffer
	if err = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 92}); err != nil {
		return "", errors.New("图片转换失败")
	}
	hash, err := a.storeJPEG(buf.Bytes())
	if err != nil {
		return "", errors.New("图片保存失败")
	}
	return hash, nil
}

// saveOriginal 保存手机取回的原图：JPEG 原样保存，PNG/GIF 转成高质量 JPEG。
func (a *App) saveOriginal(data []byte) (string, error) {
	// 按文件内容判断格式，不信任文件名
	switch http.DetectContentType(data) {
	case "image/jpeg":
		return a.storeJPEG(data)
	case "image/png", "image/gif":
		img, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return "", errors.New("原图已损坏")
		}
		var buf bytes.Buffer
		if err = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
			return "", errors.New("原图转换失败")
		}
		return a.storeJPEG(buf.Bytes())
	default:
		return "", errors.New("不支持的原图格式")
	}
}

// imageExists 图片是否已保存。
func (a *App) imageExists(hash string) bool {
	path, ok := a.mediaPath(hash)
	if !ok {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

// readImage 读取已保存的图片，返回 Base64。
func (a *App) readImage(hash string) (string, error) {
	path, ok := a.mediaPath(hash)
	if !ok {
		return "", errors.New("图片编号无效")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("图片文件不存在")
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// ---------- 网页接口 ----------

// uploadMedia 保存网页上传的图片（Base64），返回图片哈希，发送图片时使用。
func (a *App) uploadMedia(c *gin.Context) {
	var body struct {
		Data string `json:"data"`
	}
	if !bind(c, &body) {
		return
	}
	hash, err := a.saveImage(body.Data)
	if err != nil {
		fail(c, 400, err.Error())
		return
	}
	c.JSON(200, gin.H{"image_hash": hash})
}

// getMedia 返回图片文件。文件名是内容哈希，内容不会变，允许浏览器长期缓存，避免刷新时重复加载图片。
func (a *App) getMedia(c *gin.Context) {
	path, ok := a.mediaPath(c.Param("hash"))
	if !ok {
		fail(c, 404, "图片不存在")
		return
	}
	c.Header("Content-Type", "image/jpeg")
	c.Header("Cache-Control", "private, max-age=31536000, immutable")
	c.File(path)
}
