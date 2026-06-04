import json
import os

def load_config():
    if os.path.exists('config.json'):
        with open('config.json', 'r') as f:
            return json.load(f)
    return {}

def build_ffmpeg_command(input_path: str, output_path: str, profile_name: str = "Default") -> str:
    config = load_config()
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    
    custom_flags = profiles.get(profile_name, "")
    
    # Corrected order: -y (global) -> -i input -> custom_flags (output encoding) -> output
    return f'ffmpeg -y -i "{input_path}" {custom_flags} "{output_path}"'