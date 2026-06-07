import json
import os

def load_config():
    if os.path.exists('config.json'):
        with open('config.json', 'r') as f:
            return json.load(f)
    return {}

def build_ffmpeg_command(input_path: str, output_path: str, profile_name: str) -> str:
    config = load_config()
    profiles = config.get("ffmpeg", {}).get("profiles", {})
    
    # 1. Safely get the profile object
    profile_data = profiles.get(profile_name, {})
    
    # 2. Extract the flags (fallback to empty string if missing)
    custom_flags = profile_data.get("flags", "")
    
    # 3. Construct the secure command
    return f'ffmpeg -y -i "{input_path}" {custom_flags} "{output_path}"'