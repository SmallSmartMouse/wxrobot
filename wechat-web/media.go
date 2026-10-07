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
)

// 图片统一存为 JPEG，文件名是内容的 SHA-256，网页通过 /api/media/{hash} 访问。

func (a *App) mediaPath(hash string) (string, bool) {
	if b, err := hex.DecodeString(hash); err != nil || len(b) != sha256.Size {
		return "", false
	}
	return filepath.Join(filepath.Dir(a.path), "media", hash+".jpg"), true
}

func (a *App) storeJPEG(data []byte) (string, error) {
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	path, _ := a.mediaPath(hash)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
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
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") || cfg.Width > 4096 || cfg.Height > 4096 {
		return "", errors.New("只支持 4096×4096 以内的 PNG 或 JPEG 图片")
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", errors.New("图片已损坏")
	}
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
