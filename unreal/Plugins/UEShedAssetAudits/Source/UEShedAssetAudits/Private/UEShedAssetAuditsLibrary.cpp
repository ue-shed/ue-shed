#include "UEShedAssetAuditsLibrary.h"

#include "Dom/JsonObject.h"
#include "Engine/Texture2D.h"
#include "ImageCore.h"
#include "ImageUtils.h"
#include "Misc/Base64.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
constexpr int32 MinPreviewDimension = 64;
constexpr int32 MaxPreviewDimension = 512;
constexpr int64 MaxSourcePixels = 128ll * 1024ll * 1024ll;
constexpr int64 MaxEncodedBytes = 4ll * 1024ll * 1024ll;

TSharedRef<FJsonObject> Contract()
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("name"), TEXT("texture-preview"));
	const TSharedRef<FJsonObject> Version = MakeShared<FJsonObject>();
	Version->SetNumberField(TEXT("major"), 1);
	Version->SetNumberField(TEXT("minor"), 0);
	Result->SetObjectField(TEXT("version"), Version);
	return Result;
}

FString JsonString(const TSharedRef<FJsonObject>& Value)
{
	FString Result;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Result);
	FJsonSerializer::Serialize(Value, Writer);
	return Result;
}

FString Unavailable(
	const FString& ObjectPath, const TCHAR* Reason, const FString& Message, bool bRetrySafe)
{
	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("contract"), Contract());
	Result->SetStringField(TEXT("status"), TEXT("unavailable"));
	Result->SetStringField(TEXT("objectPath"), ObjectPath);
	Result->SetStringField(TEXT("reason"), Reason);
	Result->SetStringField(TEXT("message"), Message);
	Result->SetBoolField(TEXT("retrySafe"), bRetrySafe);
	return JsonString(Result);
}
}

FString UUEShedAssetAuditsLibrary::BuildTexturePreviewJson(
	const FString& TextureObjectPath, int32 MaxDimension, const FString& Authority)
{
	FString ResultJson;
#if WITH_EDITORONLY_DATA
	if (TextureObjectPath.IsEmpty())
	{
		ResultJson = Unavailable(
			TextureObjectPath, TEXT("invalid_request"), TEXT("Texture object path is required"), false);
		return ResultJson;
	}
	if (MaxDimension < MinPreviewDimension || MaxDimension > MaxPreviewDimension)
	{
		ResultJson = Unavailable(TextureObjectPath, TEXT("invalid_request"),
			FString::Printf(TEXT("MaxDimension must be between %d and %d"),
				MinPreviewDimension, MaxPreviewDimension), false);
		return ResultJson;
	}

	UTexture2D* Texture = LoadObject<UTexture2D>(nullptr, *TextureObjectPath);
	if (!Texture)
	{
		ResultJson = Unavailable(TextureObjectPath, TEXT("texture_not_found"),
			TEXT("Unreal could not load the requested Texture2D"), true);
		return ResultJson;
	}
	const int64 SourcePixels = Texture->Source.GetTotalTopMipPixelCount();
	if (SourcePixels <= 0)
	{
		ResultJson = Unavailable(TextureObjectPath, TEXT("source_unavailable"),
			TEXT("The texture has no editor source pixels"), false);
		return ResultJson;
	}
	if (SourcePixels > MaxSourcePixels)
	{
		ResultJson = Unavailable(TextureObjectPath, TEXT("source_too_large"),
			TEXT("The texture source exceeds the bounded preview pixel limit"), false);
		return ResultJson;
	}

	FImage SourceImage;
	if (!FImageUtils::GetTexture2DSourceImage(Texture, SourceImage))
	{
		ResultJson = Unavailable(TextureObjectPath, TEXT("decode_failed"),
			TEXT("Unreal could not decode the texture source image"), true);
		return ResultJson;
	}
	const double Scale = FMath::Min(1.0,
		static_cast<double>(MaxDimension) / FMath::Max(SourceImage.SizeX, SourceImage.SizeY));
	const int32 PreviewWidth = FMath::Max(1, FMath::RoundToInt(SourceImage.SizeX * Scale));
	const int32 PreviewHeight = FMath::Max(1, FMath::RoundToInt(SourceImage.SizeY * Scale));
	FImage PreviewImage;
	SourceImage.ResizeTo(
		PreviewImage, PreviewWidth, PreviewHeight, ERawImageFormat::BGRA8, SourceImage.GammaSpace);

	TArray64<uint8> Encoded;
	if (!FImageUtils::CompressImage(Encoded, TEXT("png"), PreviewImage) || Encoded.IsEmpty())
	{
		ResultJson = Unavailable(TextureObjectPath, TEXT("encode_failed"),
			TEXT("Unreal could not encode the bounded texture preview"), true);
		return ResultJson;
	}
	if (Encoded.Num() > MaxEncodedBytes)
	{
		ResultJson = Unavailable(TextureObjectPath, TEXT("preview_too_large"),
			TEXT("The encoded texture preview exceeds four MiB"), false);
		return ResultJson;
	}

	const TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("contract"), Contract());
	Result->SetStringField(TEXT("status"), TEXT("available"));
	Result->SetStringField(TEXT("authority"), Authority);
	Result->SetStringField(TEXT("objectPath"), TextureObjectPath);
	Result->SetStringField(TEXT("mimeType"), TEXT("image/png"));
	Result->SetNumberField(TEXT("width"), PreviewWidth);
	Result->SetNumberField(TEXT("height"), PreviewHeight);
	Result->SetStringField(TEXT("dataBase64"), FBase64::Encode(Encoded.GetData(), Encoded.Num()));
	ResultJson = JsonString(Result);
#else
	ResultJson = Unavailable(TextureObjectPath, TEXT("editor_data_unavailable"),
		TEXT("Texture previews require an Unreal editor build"), false);
#endif
	return ResultJson;
}

void UUEShedAssetAuditsLibrary::GetTexturePreview(
	const FString& TextureObjectPath, int32 MaxDimension, FString& ResultJson)
{
	ResultJson = BuildTexturePreviewJson(TextureObjectPath, MaxDimension, TEXT("live_editor"));
}
